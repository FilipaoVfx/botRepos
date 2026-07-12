import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import {
  upsertVectors,
  deleteVectorsByFilter,
  getPineconeStats,
} from "./rag-pinecone.js";
import { getEmbeddings } from "./rag-openai.js";
import {
  buildBookmarkContent,
  deriveBookmarkTitle,
  extractBookmarkTags,
  chunkText,
  buildReadmeContent,
  chunkReadmeByHeadings,
  contentHash,
  sanitizeForPinecone,
} from "./rag-chunking.js";

let supabase = null;

function getSupabase() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required");
  }

  supabase = createClient(url, key);
  return supabase;
}

const BATCH_SIZE = 10;

// ─── Sync State Management ────────────────────────────────────────────

// Cache del sync-state completo por source_type: 2-3 queries paginadas en vez
// de una por chunk (miles de round-trips seriales mataban el cron de Actions).
const syncStateCache = new Map(); // sourceType -> Map("id:chunk" -> {content_hash})

async function loadSyncStateMap(sourceType) {
  if (syncStateCache.has(sourceType)) return syncStateCache.get(sourceType);
  const db = getSupabase();
  const map = new Map();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("rag_sync_state")
      .select("source_id, chunk_index, content_hash")
      .eq("source_type", sourceType)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    for (const r of rows) map.set(`${r.source_id}:${r.chunk_index}`, { content_hash: r.content_hash });
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  syncStateCache.set(sourceType, map);
  return map;
}

async function getSyncState(sourceType, sourceId, chunkIndex) {
  const map = await loadSyncStateMap(sourceType);
  return map.get(`${sourceId}:${chunkIndex}`) || null;
}

// Acumula upserts y los aplica en lotes (200) en vez de uno por chunk.
const pendingSyncRows = [];

async function flushSyncState() {
  if (pendingSyncRows.length === 0) return;
  const db = getSupabase();
  for (let i = 0; i < pendingSyncRows.length; i += 200) {
    const { error } = await db
      .from("rag_sync_state")
      .upsert(pendingSyncRows.slice(i, i + 200), { onConflict: "source_type,source_id,chunk_index" });
    if (error) console.error("[RAG] sync-state flush:", error.message);
  }
  pendingSyncRows.length = 0;
}

async function saveSyncState(sourceType, sourceId, chunkIndex, pineconeId, hash) {
  // Refleja en el cache para dedup dentro de la misma corrida.
  const map = await loadSyncStateMap(sourceType);
  map.set(`${sourceId}:${chunkIndex}`, { content_hash: hash });
  pendingSyncRows.push({
    source_type: sourceType,
    source_id: sourceId,
    chunk_index: chunkIndex,
    pinecone_id: pineconeId,
    content_hash: hash,
    synced_at: new Date().toISOString(),
  });
  if (pendingSyncRows.length >= 200) await flushSyncState();
}

async function deleteSyncState(sourceType, sourceId) {
  const db = getSupabase();
  await db
    .from("rag_sync_state")
    .delete()
    .eq("source_type", sourceType)
    .eq("source_id", sourceId);
}

// ─── Bookmark Ingestion ──────────────────────────────────────────────

async function fetchBookmarks(options = {}) {
  const db = getSupabase();
  const { limit = 100, offset = 0, since = null, userId = null } = options;

  // Supabase capa cada request a 1000 filas: paginar hasta cubrir `limit`.
  const all = [];
  const pageSize = 1000;
  let from = offset;
  while (all.length < limit) {
    const to = Math.min(from + pageSize, offset + limit) - 1;
    let query = db
      .from("bookmarks")
      .select(
        "id, tweet_id, text_content, author_username, author_name, source_url, links, first_comment_links, created_at"
      )
      .order("created_at", { ascending: false })
      .range(from, to);

    if (userId) query = query.eq("user_id", userId);
    if (since) query = query.gte("updated_at", since);

    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < to - from + 1) break; // agotado
    from = to + 1;
  }
  return all;
}

export async function ingestBookmarks(options = {}) {
  const { limit = 100, offset = 0, since = null, userId = null, verbose = false } = options;

  console.log(
    `[RAG] Starting bookmark ingestion (limit=${limit}, offset=${offset}${userId ? `, user=${userId}` : ""})`
  );

  const bookmarks = await fetchBookmarks({ limit, offset, since, userId });
  console.log(`[RAG] Fetched ${bookmarks.length} bookmarks`);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const vectors = [];

    // Pasada 1: junta los chunks que faltan; pasada 2: UNA llamada de
    // embeddings por lote (antes: una llamada OpenAI por chunk).
    const work = [];
    for (const bookmark of batch) {
      try {
        const content = buildBookmarkContent(bookmark);
        const hash = contentHash(content);
        const chunks = chunkText(content);

        for (const [idx, chunk] of chunks.entries()) {
          const existing = await getSyncState("bookmark", bookmark.id, idx);
          if (existing && existing.content_hash === hash) {
            skipped++;
            continue;
          }
          work.push({ bookmark, idx, text: chunk.text, hash });
        }

        if (verbose) {
          console.log(
            `[RAG] Processed bookmark ${i + batch.indexOf(bookmark) + 1}/${bookmarks.length}: ${bookmark.id}`
          );
        }
      } catch (err) {
        errors++;
        console.error(`[RAG] Error processing bookmark ${bookmark.id}:`, err.message);
      }
    }

    if (work.length > 0) {
      try {
        const embeddings = await getEmbeddings(work.map((w) => w.text));
        for (const [j, w] of work.entries()) {
          const pineconeId = `bookmark_${w.bookmark.id}_chunk_${w.idx}`;
          vectors.push({
            id: pineconeId,
            values: embeddings[j],
            metadata: {
              source_type: "bookmark",
              item_id: w.bookmark.id,
              title: sanitizeForPinecone(deriveBookmarkTitle(w.bookmark)),
              url: sanitizeForPinecone(w.bookmark.source_url || ""),
              author: sanitizeForPinecone(w.bookmark.author_username || ""),
              text: sanitizeForPinecone(w.text.slice(0, 1000)),
              chunk_index: w.idx,
              tags: extractBookmarkTags(w.bookmark),
              created_at: w.bookmark.created_at || new Date().toISOString(),
            },
          });
          await saveSyncState("bookmark", w.bookmark.id, w.idx, pineconeId, w.hash);
          ingested++;
        }
      } catch (err) {
        errors += work.length;
        console.error(`[RAG] Error embedding batch:`, err.message);
      }
    }

    // Upsert batch to Pinecone
    if (vectors.length > 0) {
      await upsertVectors(vectors);
    }
  }

  await flushSyncState();
  const stats = await getPineconeStats();
  console.log(`[RAG] Bookmark ingestion complete: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
  console.log(`[RAG] Pinecone total vectors: ${stats.totalVectorCount || "unknown"}`);

  return { ingested, skipped, errors, total: bookmarks.length };
}

// ─── README Ingestion ────────────────────────────────────────────────

async function fetchReadmes(options = {}) {
  const db = getSupabase();
  const { limit = 50, offset = 0, since = null } = options;

  let query = db
    .from("github_repo_readmes")
    .select(
      "repo_slug, owner, repo, repo_url, content, content_chars, fetched_at"
    )
    .eq("status", "ok")
    .order("fetched_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (since) {
    query = query.gte("updated_at", since);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function ingestReadmes(options = {}) {
  const { limit = 50, offset = 0, since = null, verbose = false } = options;

  console.log(`[RAG] Starting README ingestion (limit=${limit}, offset=${offset})`);

  const readmes = await fetchReadmes({ limit, offset, since });
  console.log(`[RAG] Fetched ${readmes.length} READMEs`);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  const FLUSH_CHUNKS = 50;

  for (let i = 0; i < readmes.length; i += BATCH_SIZE) {
    const batch = readmes.slice(i, i + BATCH_SIZE);

    for (const readme of batch) {
      const vectors = [];
      try {
        const content = buildReadmeContent(readme);
        const hash = contentHash(content);
        const chunks = chunkReadmeByHeadings(readme.content || "");

        let allSkipped = true;
        for (const chunk of chunks) {
          const existing = await getSyncState("readme", readme.repo_slug, chunk.chunk_index);
          if (existing && existing.content_hash === hash) {
            skipped++;
            continue;
          }
          allSkipped = false;

          const [embedding] = await getEmbeddings([chunk.text]);

          vectors.push({
            id: `readme_${readme.repo_slug}_chunk_${chunk.chunk_index}`,
            values: embedding,
            metadata: {
              source_type: "readme",
              item_id: readme.repo_slug,
              title: sanitizeForPinecone(`${readme.repo_slug} - ${chunk.heading || `Section ${chunk.chunk_index}`}`),
              url: sanitizeForPinecone(readme.repo_url || `https://github.com/${readme.repo_slug}`),
              author: sanitizeForPinecone(readme.repo_slug),
              text: sanitizeForPinecone(chunk.text.slice(0, 1000)),
              chunk_index: chunk.chunk_index,
              tags: [readme.owner, readme.repo].filter(Boolean),
              created_at: readme.fetched_at || new Date().toISOString(),
            },
          });

          // Flush every FLUSH_CHUNKS to stay under 4MB Pinecone limit
          if (vectors.length >= FLUSH_CHUNKS) {
            await upsertVectors(vectors);
            ingested += vectors.length;
            vectors.length = 0;
          }
        }

        if (vectors.length > 0) {
          await upsertVectors(vectors);
          ingested += vectors.length;
        }

        // Save sync state for all chunks
        for (const chunk of chunks) {
          const pineconeId = `readme_${readme.repo_slug}_chunk_${chunk.chunk_index}`;
          await saveSyncState("readme", readme.repo_slug, chunk.chunk_index, pineconeId, hash);
        }

        if (verbose) {
          const status = allSkipped ? "skipped" : `${chunks.length} chunks processed`;
          console.log(
            `[RAG] Processed README ${i + batch.indexOf(readme) + 1}/${readmes.length}: ${readme.repo_slug} (${status})`
          );
        }
      } catch (err) {
        errors++;
        console.error(`[RAG] Error processing README ${readme.repo_slug}:`, err.message);
      }
    }
  }

  await flushSyncState();
  const stats = await getPineconeStats();
  console.log(`[RAG] README ingestion complete: ${ingested} ingested, ${skipped} skipped, ${errors} errors`);
  console.log(`[RAG] Pinecone total vectors: ${stats.totalVectorCount || "unknown"}`);

  return { ingested, skipped, errors, total: readmes.length };
}

// ─── Full Ingestion ──────────────────────────────────────────────────

export async function ingestAll(options = {}) {
  const { verbose = false } = options;

  console.log("[RAG] Starting full ingestion...");

  const bookmarkResults = await ingestBookmarks({ limit: 2000, verbose });
  const readmeResults = await ingestReadmes({ limit: 500, verbose });

  console.log("[RAG] Full ingestion complete:");
  console.log(`[RAG]   Bookmarks: ${bookmarkResults.ingested} ingested`);
  console.log(`[RAG]   READMEs: ${readmeResults.ingested} ingested`);

  return {
    bookmarks: bookmarkResults,
    readmes: readmeResults,
  };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || "all";

// Filtro opcional por usuario: --user=<id> o env INGEST_USER_ID.
// Con esto ingestas SOLO los bookmarks de ese usuario (p. ej. x-csv-import),
// sin tocar los de otros usuarios.
const userArg = args.find((a) => a.startsWith("--user="));
const userId = userArg ? userArg.slice("--user=".length) : (process.env.INGEST_USER_ID || null);

try {
  if (command === "bookmarks") {
    await ingestBookmarks({ limit: 2000, verbose: true, userId });
  } else if (command === "readmes") {
    await ingestReadmes({ limit: 500, verbose: true });
  } else if (command === "all") {
    await ingestAll({ verbose: true });
  } else {
    console.log("Usage: node rag-ingest.js [bookmarks|readmes|all] [--user=<id>]");
    process.exit(1);
  }
} catch (err) {
  console.error("[RAG] Ingestion failed:", err);
  process.exit(1);
}
