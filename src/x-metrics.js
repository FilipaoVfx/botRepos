// Fetch dinámico de métricas de un post de X (scraper.tech).
// Endpoint: GET https://api.scraper.tech/tweet?id=<id>  header Scraper-Key.
// Devuelve las señales reales del post PADRE (likes, reposts, replies, quotes,
// bookmarks, views, verified) para alimentar el trust_score en tiempo real.

const BASE = "https://api.scraper.tech";
const CACHE_TTL_MS = Number(process.env.X_METRICS_TTL_MS) || 6 * 60 * 60 * 1000; // 6h
const cache = new Map(); // tweetId -> { v, t }

const num = (x) => {
  const n = Number(String(x ?? "").replace(/[,%]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function tweetIdFromUrl(url) {
  return (String(url || "").match(/status\/(\d+)/) || [])[1] || "";
}

/**
 * Métricas normalizadas de un tweet. null si falla.
 * @returns {{tweetId,likes,retweets,replies,quotes,bookmarks,views,verified,followers,createdAt,text}|null}
 */
export async function fetchTweetMetrics(tweetId) {
  const id = String(tweetId || "").trim();
  if (!/^\d+$/.test(id)) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;

  const key = process.env.SCRAPER_TECH_KEY;
  if (!key) throw new Error("SCRAPER_TECH_KEY requerida en .env");

  let res;
  try {
    res = await fetch(`${BASE}/tweet?id=${encodeURIComponent(id)}`, {
      headers: { "Scraper-Key": key, Accept: "application/json" },
    });
  } catch (e) {
    return null; // red caída: no bloquear al usuario
  }
  if (!res.ok) return null;

  let j;
  try {
    j = await res.json();
  } catch {
    return null;
  }
  if (!j || (j.status && j.status !== "active")) return null;

  const v = {
    tweetId: String(j.id || id),
    likes: num(j.likes),
    retweets: num(j.retweets),
    replies: num(j.replies),
    quotes: num(j.quotes),
    bookmarks: num(j.bookmarks),
    views: num(j.views),
    verified: Boolean(j.author?.blue_verified),
    followers: num(j.author?.sub_count),
    createdAt: j.created_at || null,
    text: j.text || "",
  };

  cache.set(id, { v, t: Date.now() });
  return v;
}
