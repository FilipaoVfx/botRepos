import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { queryVectors } from "./rag-pinecone.js";
import { getEmbeddingDetailed } from "./rag-openai.js";

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

// Embedding pricing — USD per 1K tokens. Only the query embedding hits OpenAI;
// there is no generative LLM step in this pipeline (retrieval-only RAG).
const EMBED_PRICE_PER_1K = {
  "text-embedding-3-small": 0.00002,
  "text-embedding-3-large": 0.00013,
  "text-embedding-ada-002": 0.0001,
};
function embeddingCost(tokens, model) {
  if (tokens == null) return null;
  const price = EMBED_PRICE_PER_1K[model] ?? EMBED_PRICE_PER_1K["text-embedding-3-small"];
  return +((tokens / 1000) * price).toFixed(8);
}

// Simple in-memory embedding cache (TTL: 5 min)
const embedCache = new Map();
const EMBED_CACHE_TTL = 300_000;
const EMBED_CACHE_MAX = 100;

// Returns { embedding, tokens, model, cached }. On a cache hit tokens = 0 (no
// OpenAI call was made), so cost attribution stays accurate.
async function getCachedEmbedding(query) {
  const key = query.toLowerCase().trim();
  const cached = embedCache.get(key);
  if (cached && Date.now() - cached.t < EMBED_CACHE_TTL) {
    return { embedding: cached.v, tokens: 0, model: cached.model, cached: true };
  }
  const { embedding, tokens, model } = await getEmbeddingDetailed(query);
  embedCache.set(key, { v: embedding, t: Date.now(), model });
  if (embedCache.size > EMBED_CACHE_MAX) {
    const oldest = [...embedCache.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    embedCache.delete(oldest[0]);
  }
  return { embedding, tokens, model, cached: false };
}

// ─── Search ──────────────────────────────────────────────────────────

export async function ragSearch(query, options = {}) {
  const {
    topK = 5,
    sourceType = null,
    interface: iface = "api",
    user = null,
  } = options;

  const startedAt = Date.now();

  // 1. Embed the query (with cache)
  const tEmbed = Date.now();
  const emb = await getCachedEmbedding(query);
  const embeddingTime = Date.now() - tEmbed;

  // 2. Query Pinecone
  const tRetrieval = Date.now();
  const filter = sourceType ? { source_type: sourceType } : {};
  const matches = await queryVectors(emb.embedding, { topK, filter });
  const retrievalTime = Date.now() - tRetrieval;

  // 3. Enrich with Supabase data (batch)
  const enriched = await batchEnrichResults(matches);

  const responseTime = Date.now() - startedAt;

  // 4. Log event (fire-and-forget, non-blocking)
  logEvent({
    interface: iface,
    user,
    query,
    resultsCount: enriched.length,
    sources: enriched.map(sourceRef),
    responseTime,
    embeddingTime,
    retrievalTime,
    tokens: emb.tokens,
    cost: embeddingCost(emb.tokens, emb.model),
    model: emb.model,
  }).catch(() => {});

  return {
    query,
    results: enriched,
    total: enriched.length,
    latency_ms: responseTime,
  };
}

// Compact, stable reference for an enriched result — stored in events.sources.
function sourceRef(r) {
  return {
    type: r.source_type ?? null,
    id: r.item_id ?? null,
    score: r.score != null ? +r.score.toFixed(4) : null,
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
export async function searchRepos(query, { topK = 5, user = null } = {}) {
  const startedAt = Date.now();
  const tEmbed = Date.now();
  const emb = await getCachedEmbedding(query);
  const embeddingTime = Date.now() - tEmbed;

  // Over-fetch chunks so that after de-duplication we still have enough repos.
  const tRetrieval = Date.now();
  const matches = await queryVectors(emb.embedding, {
    topK: topK * 5,
    filter: { source_type: "readme" },
  });
  const retrievalTime = Date.now() - tRetrieval;

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

  const responseTime = Date.now() - startedAt;

  logEvent({
    interface: "telegram-repo",
    user,
    query,
    resultsCount: repos.length,
    sources: repos.map((r) => ({ type: "readme", id: r.repo_slug, score: r.score != null ? +r.score.toFixed(4) : null })),
    responseTime,
    embeddingTime,
    retrievalTime,
    tokens: emb.tokens,
    cost: embeddingCost(emb.tokens, emb.model),
    model: emb.model,
  }).catch(() => {});

  return {
    query,
    results: repos,
    total: repos.length,
    latency_ms: responseTime,
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
    db.from("events").select("*", { count: "exact", head: true }),
  ]);

  return {
    bookmarks: bookmarks.count ?? 0,
    readmes: readmes.count ?? 0,
    queries: queries.count ?? 0,
    error: bookmarks.error?.message || readmes.error?.message || queries.error?.message || null,
  };
}

// ─── Query Analytics (observability) ─────────────────────────────────

// Percentile from an already-sorted ascending array of numbers.
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Aggregate the events table into a dashboard-ready snapshot.
// Pulls a bounded recent window (default 7 days, capped at 5000 rows) and
// computes everything in-memory — the table is tiny and this keeps it to one
// round-trip.
export async function getQueryAnalytics({ windowDays = 7, topN = 10 } = {}) {
  const db = getSupabase();
  const now = Date.now();
  const since = new Date(now - windowDays * 86400_000).toISOString();

  const { data, error } = await db
    .from("events")
    .select(
      "query, interface, results_count, response_time, embedding_time, retrieval_time, tokens, cost, user_id, username, created_at"
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw error;
  const rows = data || [];

  const ms24 = now - 86400_000;
  const ms1h = now - 3600_000;
  const t = (r) => new Date(r.created_at).getTime();

  const last24 = rows.filter((r) => t(r) >= ms24);
  const lastHour = rows.filter((r) => t(r) >= ms1h);

  // Latency stats over the last 24h (fall back to full window if sparse).
  const latSource = last24.length >= 5 ? last24 : rows;
  const latencies = latSource
    .map((r) => r.response_time || 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const avg = latencies.length
    ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length)
    : 0;

  // Phase timing averages (last 24h) + token / cost usage.
  const avgOf = (src, k) => {
    const v = src.map((r) => r[k] || 0).filter((n) => n > 0);
    return v.length ? Math.round(v.reduce((s, n) => s + n, 0) / v.length) : 0;
  };
  const sumOf = (src, k) => src.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  // Success = at least one result returned.
  const withResults = rows.filter((r) => (r.results_count ?? 0) > 0).length;
  const successRate = rows.length ? Math.round((withResults / rows.length) * 100) : 100;

  // Zero-result queries = the content-gap signal.
  const zero = rows.filter((r) => (r.results_count ?? 0) === 0);

  // Group by interface.
  const ifaceMap = new Map();
  for (const r of rows) {
    const k = r.interface || "unknown";
    const e = ifaceMap.get(k) || { interface: k, count: 0, latSum: 0 };
    e.count++;
    e.latSum += r.response_time || 0;
    ifaceMap.set(k, e);
  }
  const byInterface = [...ifaceMap.values()]
    .map((e) => ({ interface: e.interface, count: e.count, avgLatency: Math.round(e.latSum / e.count) }))
    .sort((a, b) => b.count - a.count);

  // Top queries (normalized, case-insensitive).
  const qMap = new Map();
  for (const r of rows) {
    const key = (r.query || "").trim().toLowerCase();
    if (!key) continue;
    const e = qMap.get(key) || { query: r.query.trim(), count: 0, lastAt: r.created_at };
    e.count++;
    if (new Date(r.created_at) > new Date(e.lastAt)) e.lastAt = r.created_at;
    qMap.set(key, e);
  }
  const topQueries = [...qMap.values()].sort((a, b) => b.count - a.count).slice(0, topN);

  // Top users (Telegram only — rows carrying a user_id).
  const uMap = new Map();
  for (const r of rows) {
    if (r.user_id == null) continue;
    const e = uMap.get(r.user_id) || {
      user_id: r.user_id,
      username: r.username || null,
      count: 0,
      lastAt: r.created_at,
    };
    e.count++;
    if (!e.username && r.username) e.username = r.username;
    if (new Date(r.created_at) > new Date(e.lastAt)) e.lastAt = r.created_at;
    uMap.set(r.user_id, e);
  }
  const topUsers = [...uMap.values()].sort((a, b) => b.count - a.count).slice(0, topN);

  // Hourly volume for the last 24h (24 buckets, oldest→newest).
  const buckets = new Array(24).fill(0);
  const errBuckets = new Array(24).fill(0);
  for (const r of last24) {
    const hoursAgo = Math.floor((now - t(r)) / 3600_000);
    if (hoursAgo >= 0 && hoursAgo < 24) {
      const idx = 23 - hoursAgo;
      buckets[idx]++;
      if ((r.results_count ?? 0) === 0) errBuckets[idx]++;
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    totals: { all: rows.length, last24h: last24.length, lastHour: lastHour.length },
    latency: {
      avg,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? latencies[latencies.length - 1] : 0,
    },
    successRate,
    zeroResults: {
      total: zero.length,
      last24h: zero.filter((r) => t(r) >= ms24).length,
      recent: zero.slice(0, topN).map((r) => ({
        query: r.query,
        interface: r.interface,
        created_at: r.created_at,
      })),
    },
    byInterface,
    topQueries,
    topUsers,
    uniqueUsers: uMap.size,
    phases: {
      embeddingAvg: avgOf(latSource, "embedding_time"),
      retrievalAvg: avgOf(latSource, "retrieval_time"),
    },
    usage: {
      tokens24h: sumOf(last24, "tokens"),
      tokensAll: sumOf(rows, "tokens"),
      cost24h: +sumOf(last24, "cost").toFixed(6),
      costAll: +sumOf(rows, "cost").toFixed(6),
    },
    hourly: buckets,
    hourlyZero: errBuckets,
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

const asInt = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);

// Persist one observability event. Captures the query, its result, phase
// timings and OpenAI usage, plus whatever Telegram exposes about the user in
// message.from (id/username/name/language/premium) — nothing beyond the Bot
// API. Fire-and-forget: failures never affect the user-facing reply.
async function logEvent(ev) {
  try {
    const db = getSupabase();
    const u = ev.user || {};
    await db.from("events").insert({
      interface: ev.interface,
      user_id: u.id ?? null,
      username: u.username ?? null,
      first_name: u.first_name ?? null,
      last_name: u.last_name ?? null,
      language_code: u.language_code ?? null,
      is_premium: u.is_premium ?? null,
      is_bot: u.is_bot ?? null,
      chat_id: u.chat_id ?? null,
      chat_type: u.chat_type ?? null,
      query: ev.query,
      results_count: ev.resultsCount ?? 0,
      sources: ev.sources ?? null,
      response_time: asInt(ev.responseTime),
      embedding_time: asInt(ev.embeddingTime),
      retrieval_time: asInt(ev.retrievalTime),
      llm_time: null, // retrieval-only RAG: no generative step
      tokens: asInt(ev.tokens),
      cost: ev.cost ?? null,
      model: ev.model ?? null,
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
