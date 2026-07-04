import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { queryVectors } from "./rag-pinecone.js";
import { getEmbedding } from "./rag-openai.js";

let supabase = null;

function getSupabase() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  supabase = createClient(url, key);
  return supabase;
}

// Simple in-memory embedding cache (TTL: 5 min)
const embedCache = new Map();
const EMBED_CACHE_TTL = 300_000;
const EMBED_CACHE_MAX = 100;

async function getCachedEmbedding(query) {
  const key = query.toLowerCase().trim();
  const cached = embedCache.get(key);
  if (cached && Date.now() - cached.t < EMBED_CACHE_TTL) {
    return cached.v;
  }
  const embedding = await getEmbedding(query);
  embedCache.set(key, { v: embedding, t: Date.now() });
  if (embedCache.size > EMBED_CACHE_MAX) {
    const oldest = [...embedCache.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    embedCache.delete(oldest[0]);
  }
  return embedding;
}

// ─── Search ──────────────────────────────────────────────────────────

export async function ragSearch(query, options = {}) {
  const {
    topK = 5,
    sourceType = null,
    interface: iface = "api",
  } = options;

  const startedAt = Date.now();

  // 1. Embed the query (with cache)
  const queryEmbedding = await getCachedEmbedding(query);

  // 2. Query Pinecone
  const filter = sourceType ? { source_type: sourceType } : {};
  const matches = await queryVectors(queryEmbedding, { topK, filter });

  // 3. Enrich with Supabase data (batch)
  const enriched = await batchEnrichResults(matches);

  // 4. Log query (fire-and-forget, non-blocking)
  logQuery(query, iface, enriched.length, Date.now() - startedAt).catch(() => {});

  return {
    query,
    results: enriched,
    total: enriched.length,
    latency_ms: Date.now() - startedAt,
  };
}

// ─── Repos: list, semantic search, detail ────────────────────────────

// List all indexed repos (github_repo_readmes) with pagination.
export async function listRepos({ page = 1, pageSize = 5 } = {}) {
  const db = getSupabase();
  const safePage = Math.max(1, page);
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, count, error } = await db
    .from("github_repo_readmes")
    .select("repo_slug, owner, repo, repo_url, content_chars, fetched_at", {
      count: "exact",
    })
    .eq("status", "ok")
    .order("fetched_at", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    repos: data || [],
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

// Semantic search restricted to repos only (source_type = readme).
// Dedupes chunk-level matches down to unique repos, keeping the best score.
export async function searchRepos(query, { topK = 5 } = {}) {
  const startedAt = Date.now();
  const queryEmbedding = await getCachedEmbedding(query);

  // Over-fetch chunks so that after de-duplication we still have enough repos.
  const matches = await queryVectors(queryEmbedding, {
    topK: topK * 5,
    filter: { source_type: "readme" },
  });

  const bySlug = new Map();
  for (const match of matches) {
    const slug = match.metadata?.item_id;
    if (!slug) continue;
    const score = match.score || 0;
    if (!bySlug.has(slug) || score > bySlug.get(slug).score) {
      bySlug.set(slug, {
        repo_slug: slug,
        score,
        url: match.metadata?.url || `https://github.com/${slug}`,
      });
    }
  }

  const repos = [...bySlug.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  logQuery(query, "telegram-repo", repos.length, Date.now() - startedAt).catch(
    () => {}
  );

  return {
    query,
    results: repos,
    total: repos.length,
    latency_ms: Date.now() - startedAt,
  };
}

// Full metadata for a single repo + the origin post(s) that referenced it.
export async function getRepoDetail(slug) {
  const db = getSupabase();

  const { data: repo, error } = await db
    .from("github_repo_readmes")
    .select(
      "repo_slug, owner, repo, repo_url, readme_html_url, content_chars, size_bytes, status, fetched_at, created_at"
    )
    .eq("repo_slug", slug)
    .single();

  if (error || !repo) return null;

  const origins = await findRepoOrigins(slug, repo.repo_url);
  return { repo, origins };
}

// Find the bookmark(s) (origin posts) whose links reference this repo.
async function findRepoOrigins(slug, repoUrl) {
  const db = getSupabase();

  const base = `https://github.com/${slug}`;
  const variants = [
    ...new Set([base, `${base}/`, repoUrl, repoUrl && `${repoUrl}/`].filter(Boolean)),
  ];

  const seen = new Map();
  const addRows = (rows) => {
    for (const r of rows || []) if (!seen.has(r.id)) seen.set(r.id, r);
  };

  const cols = "id, source_url, author_username, author_name, text_content, created_at";

  // Match on the links array and the first-comment links array.
  for (const field of ["links", "first_comment_links"]) {
    const { data } = await db
      .from("bookmarks")
      .select(cols)
      .overlaps(field, variants)
      .limit(5);
    addRows(data);
  }

  // Fallback: the repo URL mentioned inline in the tweet text.
  if (seen.size === 0) {
    const { data } = await db
      .from("bookmarks")
      .select(cols)
      .ilike("text_content", `%github.com/${slug}%`)
      .limit(5);
    addRows(data);
  }

  return [...seen.values()]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(0, 5);
}

// ─── Knowledge Base Stats ────────────────────────────────────────────

export async function getKnowledgeStats() {
  const db = getSupabase();

  const [bookmarks, readmes, queries] = await Promise.all([
    db.from("bookmarks").select("*", { count: "exact", head: true }),
    db.from("github_repo_readmes").select("*", { count: "exact", head: true }),
    db.from("rag_queries_log").select("*", { count: "exact", head: true }),
  ]);

  return {
    bookmarks: bookmarks.count ?? 0,
    readmes: readmes.count ?? 0,
    queries: queries.count ?? 0,
    error: bookmarks.error?.message || readmes.error?.message || queries.error?.message || null,
  };
}

// ─── Batch Enrichment (2 queries total, vs 5-sequential) ────────────

async function batchEnrichResults(matches) {
  const db = getSupabase();

  // Separate by type and collect IDs
  const bookmarkIds = [];
  const readmeIds = [];
  for (const match of matches) {
    const t = match.metadata?.source_type;
    const id = match.metadata?.item_id;
    if (t === "bookmark" && id) bookmarkIds.push(id);
    else if (t === "readme" && id) readmeIds.push(id);
  }

  // Batch fetch all bookmarks (1 query)
  const bookmarkMap = {};
  if (bookmarkIds.length > 0) {
    const { data } = await db
      .from("bookmarks")
      .select("id, text_content, author_username, author_name, source_url")
      .in("id", bookmarkIds);
    for (const row of data || []) bookmarkMap[row.id] = row;
  }

  // Batch fetch all readmes (1 query)
  const readmeMap = {};
  if (readmeIds.length > 0) {
    const { data } = await db
      .from("github_repo_readmes")
      .select("repo_slug, repo_url, content_chars")
      .in("repo_slug", readmeIds);
    for (const row of data || []) readmeMap[row.repo_slug] = row;
  }

  // Build results from cached data
  const results = [];
  for (const match of matches) {
    const meta = match.metadata || {};
    const score = match.score || 0;

    const enriched = {
      score,
      source_type: meta.source_type,
      item_id: meta.item_id,
      title: meta.title || "",
      url: meta.url || "",
      author: meta.author || "",
      text: meta.text || "",
      chunk_index: meta.chunk_index || 0,
      tags: meta.tags || [],
      created_at: meta.created_at || "",
      pinecone_id: match.id,
    };

    if (meta.source_type === "bookmark") {
      const row = bookmarkMap[meta.item_id];
      if (row) {
        enriched.title = deriveTitle(row);
        enriched.author = row.author_username || "";
        enriched.url = row.source_url || "";
      }
    } else if (meta.source_type === "readme") {
      const row = readmeMap[meta.item_id];
      if (row) {
        enriched.title = row.repo_slug;
        enriched.url = row.repo_url || `https://github.com/${row.repo_slug}`;
      }
    }

    results.push(enriched);
  }

  return results;
}

// ─── Title Derivation ────────────────────────────────────────────────

function deriveTitle(bookmark) {
  const text = bookmark.text_content || "";
  if (text.length > 0) {
    const firstSentence = text.split(/[.!?\n]/)[0].trim();
    if (firstSentence.length > 5 && firstSentence.length <= 120) {
      return firstSentence;
    }
    if (firstSentence.length > 120) {
      return firstSentence.slice(0, 117) + "...";
    }
  }
  return bookmark.author_username ? `Bookmark by @${bookmark.author_username}` : "Untitled";
}

// ─── Query Logging ───────────────────────────────────────────────────

async function logQuery(query, iface, resultsCount, latencyMs) {
  try {
    const db = getSupabase();
    await db.from("rag_queries_log").insert({
      query,
      interface: iface,
      results_count: resultsCount,
      latency_ms: latencyMs,
    });
  } catch {
    // Non-critical, ignore
  }
}

// ─── CLI Entry Point (only when run directly) ────────────────────────

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    const query = args.join(" ");
    console.log(`[RAG] Searching: "${query}"`);

    try {
      const results = await ragSearch(query, { topK: 5, interface: "cli" });
      console.log(`\n[Results: ${results.total} | ${results.latency_ms}ms]\n`);

      results.results.forEach((r, i) => {
        const icon = r.source_type === "readme" ? "📦" : "🔖";
        console.log(`${icon} ${i + 1}. ${r.title} (score: ${(r.score * 100).toFixed(1)}%)`);
        if (r.url) console.log(`   ${r.url}`);
        console.log(`   ${r.text.slice(0, 150)}...`);
        console.log();
      });
    } catch (err) {
      console.error("[RAG] Search failed:", err.message);
      process.exit(1);
    }
  }
}
