import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { queryVectors } from "./rag-pinecone.js";
import { getEmbeddingDetailed } from "./rag-openai.js";
import { fetchTweetMetrics, tweetIdFromUrl } from "./x-metrics.js";
import {
  spoolEvent,
  flushEvents,
  startEventFlusher,
  pendingEventCount,
} from "./event-log.js";

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

  // El dataset es chico (~350 repos), así que traemos todo y rankeamos por
  // Trust Score en memoria: los repos con score salen primero sin importar
  // cuándo se bajó su README. Antes ordenábamos por fetched_at, lo que dejaba
  // en la primera página los repos recién sembrados que aún no tienen métricas.
  const { data, error } = await db
    .from("github_repo_readmes")
    .select("repo_slug, owner, repo, repo_url, content_chars, fetched_at")
    .eq("status", "ok");

  if (error) throw error;

  const repos = await attachTrustScores(data || [], (r) => r.repo_slug);
  repos.sort((a, b) => {
    const ta = a.trust_score == null ? -Infinity : a.trust_score;
    const tb = b.trust_score == null ? -Infinity : b.trust_score;
    if (tb !== ta) return tb - ta; // mayor trust primero (sin score al final)
    return new Date(b.fetched_at || 0) - new Date(a.fetched_at || 0); // desempate: recencia
  });

  const total = repos.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = (safePage - 1) * pageSize;
  const pageRepos = repos.slice(from, from + pageSize);

  return {
    repos: pageRepos,
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

  // Rerank: amplía candidatos, adjunta trust, mezcla score vectorial + trust,
  // y CORTA al final. Boost multiplicativo: el vector manda, trust empuja.
  //   final = score * (1 + BOOST * trust/10)   (trust null → sin empuje)
  const candidates = [...bySlug.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK * 3, topK));

  await attachTrustScores(candidates, (r) => r.repo_slug);

  const BOOST = Number(process.env.TRUST_BOOST) || 0.3;
  for (const r of candidates) {
    const t = Number.isFinite(r.trust_score) ? r.trust_score : 0;
    r.vector_score = r.score;
    r.final_score = r.score * (1 + BOOST * (t / 10));
  }

  const repos = candidates
    .sort((a, b) => b.final_score - a.final_score)
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

  const [origins, engagement] = await Promise.all([
    findRepoOrigins(slug, repo.repo_url),
    getTrustScore(slug),
  ]);
  repo.trust_score = engagement ? Number(engagement.trust_score) : null;
  return { repo, origins, engagement };
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

// ─── Trust Score (engagement de Twitter por repo) ────────────────────
// El score mide la confiabilidad de un repo por la interacción real que generó
// en Twitter (likes/saves/engagement/menciones/impresiones). La fórmula vive en
// un único sitio — la usan el importador de CSV y cualquier recálculo en vivo —
// y está versionada para poder recomputar sin ambigüedad. Escala 0.00–10.00.
// Detalle y pesos: trust_score.md.
export const TRUST_SCORE_VERSION = 2;

// v2: métricas reales del post PADRE (scraper.tech). engagement_rate se computa
// aquí como interacciones/views (fracción real), no el % roto del CSV viejo.
// Acepta tanto el objeto raw en vivo (likes, retweets, ...) como una fila
// almacenada (avg_likes, avg_saves, ...) para poder recomputar sin re-fetch.
export function computeTrustScore(m = {}) {
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const likes = n(m.likes ?? m.avg_likes);
  const bookmarks = n(m.bookmarks ?? m.avg_saves);
  const views = n(m.views ?? m.avg_impressions);
  const retweets = n(m.retweets ?? m.avg_reposts);
  const replies = n(m.replies ?? m.avg_replies);
  const quotes = n(m.quotes);
  const mentions = n(m.mentions_count);
  const verified = Boolean(m.verified);
  const inter =
    m.avg_interactions != null ? n(m.avg_interactions) : likes + retweets + replies + quotes + bookmarks;
  const ratePct = views > 0 ? (inter / views) * 100 : 0; // % real de interacción

  let score =
    Math.min(likes / 100, 10) * 0.25 + // aprobación
    Math.min(bookmarks / 50, 10) * 0.2 + // saves = intención de volver
    Math.min(ratePct, 10) * 0.25 + // engagement rate real (10%+ = tope)
    Math.min(mentions, 10) * 0.15 + // reincidencia
    Math.min(views / 50000, 10) * 0.15; // alcance
  score *= verified ? 1 : 0.95; // leve penalización no-verificado

  return Math.round(score * 100) / 100; // 0.00 – 10.00
}

// Refresca el trust de UN repo con métricas EN VIVO del/los post(s) padre.
// - Resuelve los posts padre (findRepoOrigins) → tweetId.
// - fetchTweetMetrics de cada uno; agrega quedándose con el de mayor resonancia
//   (likes + bookmarks) como representante del repo. mentions_count = nº de padres.
// - Upsert en repo_engagement_metrics. Diseñado para fire-and-forget desde el bot.
// Devuelve la fila escrita, o null si no hay padre / no se pudo fetchear.
export async function refreshRepoTrust(slug) {
  const db = getSupabase();

  // Padres autoritativos: bookmark_github_repos (slug lowercase exacto), evita
  // los fallos por mayúsculas / t.co de la derivación por texto.
  const { data: linkRows } = await db
    .from("bookmark_github_repos")
    .select("bookmark_id")
    .eq("repo_slug", slug);
  const ids = [...new Set((linkRows || []).map((r) => String(r.bookmark_id)).filter(Boolean))];
  if (!ids.length) return null;

  const { data: origins } = await db
    .from("bookmarks")
    .select("id, source_url")
    .in("id", ids);
  if (!origins || !origins.length) return null;

  let best = null;
  let bestResonance = -1;
  for (const o of origins) {
    const tweetId = tweetIdFromUrl(o.source_url) || String(o.id || "");
    const m = await fetchTweetMetrics(tweetId);
    if (!m) continue;
    const resonance = m.likes + m.bookmarks;
    if (resonance > bestResonance) {
      bestResonance = resonance;
      best = { m, origin: o };
    }
  }
  if (!best) return null;

  const { m, origin } = best;
  const mentions = origins.length;
  const inter = m.likes + m.retweets + m.replies + m.quotes + m.bookmarks;
  const ratePct = m.views > 0 ? (inter / m.views) * 100 : 0;
  const round2 = (x) => Math.round(x * 100) / 100;

  const row = {
    repo_slug: slug,
    source_url: origin.source_url || `https://github.com/${slug}`,
    mentions_count: mentions,
    avg_likes: m.likes,
    avg_impressions: m.views,
    avg_interactions: inter,
    avg_saves: m.bookmarks,
    avg_shares: 0,
    avg_replies: m.replies,
    avg_reposts: m.retweets,
    avg_profile_visits: 0,
    avg_url_clicks: 0,
    avg_engagement_rate: round2(ratePct),
    avg_like_rate: m.views > 0 ? round2((m.likes / m.views) * 100) : 0,
    trust_score: computeTrustScore({ ...m, mentions_count: mentions }),
    trust_score_version: TRUST_SCORE_VERSION,
    updated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("repo_engagement_metrics")
    .upsert(row, { onConflict: "repo_slug" });
  if (error) return null;
  return row;
}

// Batch-fetch engagement metrics for a set of repo slugs → Map(slug → row).
// One round-trip; missing repos simply aren't in the map.
export async function getTrustScores(slugs = []) {
  const unique = [...new Set(slugs.filter(Boolean))];
  if (!unique.length) return new Map();
  const db = getSupabase();
  const { data, error } = await db
    .from("repo_engagement_metrics")
    .select(
      "repo_slug, trust_score, mentions_count, avg_likes, avg_saves, avg_engagement_rate, avg_impressions, trust_score_version, updated_at"
    )
    .in("repo_slug", unique);
  if (error) return new Map(); // non-critical: repos just render without a score
  return new Map((data || []).map((r) => [r.repo_slug, r]));
}

// Single repo's engagement metrics (or null).
export async function getTrustScore(slug) {
  return (await getTrustScores([slug])).get(slug) || null;
}

// Attach `trust_score` (and the raw metrics under `engagement`) to a list of
// repo-shaped objects. Non-destructive: repos without metrics get trust_score
// = null. `slugOf` maps an item to its repo_slug.
async function attachTrustScores(items, slugOf) {
  if (!items || !items.length) return items;
  const scores = await getTrustScores(items.map(slugOf));
  for (const it of items) {
    const m = scores.get(slugOf(it));
    it.trust_score = m ? Number(m.trust_score) : null;
    it.engagement = m || null;
  }
  return items;
}

// Leaderboard: top repos by trust_score, joined with readme metadata via the FK.
export async function getTopReposByTrust({ limit = 10 } = {}) {
  const db = getSupabase();
  const { data, error } = await db
    .from("repo_engagement_metrics")
    .select(
      "repo_slug, trust_score, mentions_count, avg_likes, avg_engagement_rate, github_repo_readmes(owner, repo, repo_url)"
    )
    .order("trust_score", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((r) => ({
    repo_slug: r.repo_slug,
    trust_score: Number(r.trust_score),
    mentions_count: r.mentions_count,
    avg_likes: Number(r.avg_likes),
    avg_engagement_rate: Number(r.avg_engagement_rate),
    owner: r.github_repo_readmes?.owner ?? null,
    repo: r.github_repo_readmes?.repo ?? null,
    repo_url: r.github_repo_readmes?.repo_url ?? null,
  }));
}

// ─── Knowledge Base Stats ────────────────────────────────────────────

export async function getKnowledgeStats() {
  const db = getSupabase();

  const [bookmarks, readmes, events, legacy] = await Promise.all([
    db.from("bookmarks").select("*", { count: "exact", head: true }),
    db.from("github_repo_readmes").select("*", { count: "exact", head: true }),
    db.from("events").select("*", { count: "exact", head: true }),
    db.from("rag_queries_log").select("*", { count: "exact", head: true }),
  ]);

  return {
    bookmarks: bookmarks.count ?? 0,
    readmes: readmes.count ?? 0,
    // Total queries ever = new events + frozen historical log.
    queries: (events.count ?? 0) + (legacy.count ?? 0),
    error: bookmarks.error?.message || readmes.error?.message || events.error?.message || null,
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

  // Read from `events` (current source of truth) AND the frozen historical
  // `rag_queries_log`, merged. Nothing is written to rag_queries_log anymore, so
  // the two sets are disjoint — the union restores pre-migration history without
  // any double counting. If the legacy table is gone, we just skip it.
  const [evRes, oldRes] = await Promise.all([
    db
      .from("events")
      .select(
        "query, interface, results_count, response_time, embedding_time, retrieval_time, tokens, cost, user_id, username, created_at"
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000),
    db
      .from("rag_queries_log")
      .select("query, interface, results_count, latency_ms, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  if (evRes.error) throw evRes.error;

  const legacy = (oldRes.error ? [] : oldRes.data || []).map((r) => ({
    query: r.query,
    interface: r.interface,
    results_count: r.results_count,
    response_time: r.latency_ms,
    embedding_time: 0,
    retrieval_time: 0,
    tokens: 0,
    cost: 0,
    user_id: null,
    username: null,
    created_at: r.created_at,
  }));

  const rows = [...(evRes.data || []), ...legacy]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5000);

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
// API.
//
// Durability: the row is written to a local disk spool synchronously (see
// event-log.js), then flushed to Supabase by the background flusher. This means
// an event survives a bot restart, crash, or transient Supabase outage — it is
// replayed on the next startup instead of being lost. Failures never affect the
// user-facing reply.
async function logEvent(ev) {
  try {
    const u = ev.user || {};
    spoolEvent({
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
      // client-side timestamp so we keep ordering even if flushed much later
      created_at: new Date().toISOString(),
    });
  } catch {
    // Non-critical, ignore
  }
}

// Start the background flusher that drains the spool into Supabase (call once
// from the long-running bot process). Also replays anything pending on startup.
export function startEventLog(opts = {}) {
  return startEventFlusher(getSupabase(), opts);
}

// Force-drain the spool now and report how many events remain pending. Used by
// short-lived processes (CLI) so their events reach Supabase before exit.
export async function flushPendingEvents() {
  await flushEvents(getSupabase());
  return pendingEventCount();
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

      // Ensure this run's event reaches Supabase before the process exits.
      await flushPendingEvents().catch(() => {});
    } catch (err) {
      console.error("[RAG] Search failed:", err.message);
      process.exit(1);
    }
  }
}
