import dotenv from "dotenv";
dotenv.config({ quiet: true });

import { createClient } from "@supabase/supabase-js";
import {
  refreshRepoTrust,
  refreshRepoGithub,
  TRUST_SCORE_VERSION,
  STARS_TTL_MS,
} from "../src/rag-orchestrator.js";

// Backfill / refresco del Trust Score de las dos fuentes:
//   x      → métricas en vivo del post padre (scraper.tech, SCRAPER_TECH_KEY).
//            Cuesta créditos: una llamada por post padre del repo.
//   github → stars/forks/último push (API de GitHub; GITHUB_TOKEN sube el
//            rate limit de 60 → 5000/h).
//
//   node scripts/backfill-trust.js [--source=x|github|all] [--limit=N]
//                                  [--stale-only] [--dry-run]
//
// --stale-only: solo lo que falta o venció (X: TRUST_X_TTL_DAYS, 7 días por
//   defecto, o fórmula de versión anterior; GitHub: STARS_TTL_MS, 12 h).
// --limit: máximo de repos POR FUENTE en esta corrida (los más viejos primero).
// Sale 1 solo si una fuente intentó repos y no logró ninguno (algo está roto:
// clave inválida, rate limit, red); los fallos sueltos solo se reportan.

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const SOURCE = arg("source") || "all";
const LIMIT = Number(arg("limit")) || Infinity;
const STALE_ONLY = args.includes("--stale-only");
const DRY_RUN = args.includes("--dry-run");
const X_TTL_MS = (Number(process.env.TRUST_X_TTL_DAYS) || 7) * 86_400_000;
const X_PAUSE_MS = Number(process.env.TRUST_X_PAUSE_MS) || 1500;
const GH_PAUSE_MS = 250;

if (!["x", "github", "all"].includes(SOURCE)) {
  console.error("Uso: --source=x|github|all");
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const age = (ts) => (ts ? Date.now() - new Date(ts).getTime() : Infinity);

async function all(table, cols, filter) {
  let q = db.from(table).select(cols).limit(10000);
  if (filter) q = filter(q);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

const readmes = await all("github_repo_readmes", "repo_slug", (q) => q.eq("status", "ok"));
const slugs = readmes.map((r) => r.repo_slug);

// ─── X (scraper.tech) ────────────────────────────────────────────────

async function backfillX() {
  if (!process.env.SCRAPER_TECH_KEY) {
    console.log("[x] SCRAPER_TECH_KEY no está en .env: omito las métricas de X.");
    return true;
  }
  const links = await all("bookmark_github_repos", "repo_slug");
  const parents = new Map(); // slug → nº de posts padre (≈ llamadas a scraper.tech)
  for (const l of links) parents.set(l.repo_slug, (parents.get(l.repo_slug) || 0) + 1);
  const metrics = new Map(
    (await all("repo_engagement_metrics", "repo_slug, updated_at, trust_score_version")).map((m) => [m.repo_slug, m])
  );

  let todo = slugs
    .filter((s) => parents.has(s))
    .map((s) => ({ slug: s, row: metrics.get(s) }))
    .filter(
      ({ row }) =>
        !STALE_ONLY ||
        !row ||
        Number(row.trust_score_version) < TRUST_SCORE_VERSION ||
        age(row.updated_at) > X_TTL_MS
    )
    .sort((a, b) => age(b.row?.updated_at) - age(a.row?.updated_at)) // más viejos primero
    .slice(0, LIMIT);

  const calls = todo.reduce((n, t) => n + parents.get(t.slug), 0);
  console.log(`[x] ${todo.length} repos a refrescar (~${calls} llamadas a scraper.tech)`);
  if (DRY_RUN) {
    todo.slice(0, 15).forEach((t) => console.log(`    ${t.slug} (${t.row ? "vencido" : "sin métricas"})`));
    return true;
  }

  let ok = 0;
  let fail = 0;
  for (const [i, t] of todo.entries()) {
    try {
      const row = await refreshRepoTrust(t.slug);
      if (row) ok++;
      else fail++;
      console.log(`[x] ${i + 1}/${todo.length} ${t.slug}: ${row ? row.trust_score : "sin datos"}`);
    } catch (err) {
      fail++;
      console.log(`[x] ${i + 1}/${todo.length} ${t.slug}: error ${err.message}`);
    }
    await sleep(X_PAUSE_MS);
  }
  console.log(`[x] listo: ${ok} actualizados, ${fail} sin datos/errores`);
  return todo.length === 0 || ok > 0;
}

// ─── GitHub ──────────────────────────────────────────────────────────

async function backfillGithub() {
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    console.log("[github] sin GITHUB_TOKEN: límite de 60 req/h; usa --limit bajo.");
  }
  const meta = new Map(
    (await all("github_repositories", "repo_slug, metadata_fetched_at")).map((m) => [m.repo_slug, m])
  );
  let todo = slugs
    .map((s) => ({ slug: s, fetched: meta.get(s)?.metadata_fetched_at }))
    .filter(({ fetched }) => !STALE_ONLY || age(fetched) > STARS_TTL_MS)
    .sort((a, b) => age(b.fetched) - age(a.fetched))
    .slice(0, LIMIT);

  console.log(`[github] ${todo.length} repos a refrescar`);
  if (DRY_RUN) {
    todo.slice(0, 15).forEach((t) => console.log(`    ${t.slug} (${t.fetched || "sin metadatos"})`));
    return true;
  }

  let ok = 0;
  let fail = 0;
  for (const t of todo) {
    const info = await refreshRepoGithub(t.slug).catch(() => null);
    if (info) ok++;
    else fail++;
    await sleep(GH_PAUSE_MS);
  }
  console.log(`[github] listo: ${ok} actualizados, ${fail} fallidos (404/rate limit/red)`);
  return todo.length === 0 || ok > 0;
}

const results = [];
if (SOURCE === "x" || SOURCE === "all") results.push(await backfillX());
if (SOURCE === "github" || SOURCE === "all") results.push(await backfillGithub());
process.exit(results.every(Boolean) ? 0 : 1);
