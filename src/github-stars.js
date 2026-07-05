// Fetch REAL del número de stars de un repo de GitHub (nada sintético).
// API pública: GET https://api.github.com/repos/{owner}/{repo} -> stargazers_count.
//
// Performance: el detail NUNCA espera a GitHub — lee el valor persistido en la
// DB y este módulo sólo refresca en segundo plano. Cache TTL en memoria + un
// timeout duro evitan colgar el proceso, y todo error devuelve null (se mantiene
// el valor viejo). Si hay GITHUB_TOKEN en .env, sube el rate limit de 60 -> 5000/h.

const CACHE_TTL_MS = Number(process.env.STARS_TTL_MS) || 12 * 60 * 60 * 1000; // 12h
const FETCH_TIMEOUT_MS = Number(process.env.STARS_FETCH_TIMEOUT_MS) || 4000;
const cache = new Map(); // "owner/repo" -> { v, t }

/**
 * Devuelve el stargazers_count del repo, o null si falla / no existe.
 * @returns {Promise<number|null>}
 */
export async function fetchRepoStars(owner, repo) {
  const o = String(owner || "").trim();
  const r = String(repo || "").trim();
  if (!o || !r) return null;

  const key = `${o}/${r}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;

  const headers = { Accept: "application/vnd.github+json", "User-Agent": "botRepos" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${o}/${r}`, { headers, signal: ctrl.signal });
  } catch {
    return null; // red caída / timeout: no romper el flujo
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null; // 404 (repo movido/privado) o 403 (rate limit): mantener valor viejo

  let j;
  try {
    j = await res.json();
  } catch {
    return null;
  }
  const stars = Number(j?.stargazers_count);
  if (!Number.isFinite(stars)) return null;

  cache.set(key, { v: stars, t: Date.now() });
  return stars;
}
