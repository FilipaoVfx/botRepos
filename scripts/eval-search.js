import dotenv from "dotenv";
dotenv.config({ quiet: true });

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { ragSearch } from "../src/rag-orchestrator.js";

// Evaluación offline de la búsqueda (ragSearch, la de /search y texto libre).
// Usa eval/queries.json y NO registra eventos (log: false). Cada consulta
// cuesta un embedding (~10 tokens): la corrida completa cuesta centavos de centavo.
//
//   node scripts/eval-search.js [--top=5] [--verbose] [--save=eval/ultima.json]
//
// Métricas:
//   labeled   → hit@3, hit@5 y MRR (1/posición del primer acierto). Acierto =
//               README esperado o bookmark que enlaza a ese repo.
//   todas     → % de búsquedas con resultados duplicados (mismo documento más de
//               una vez), promedio de resultados y % sin resultados.

const args = process.argv.slice(2);
const TOP = Number(args.find((a) => a.startsWith("--top="))?.split("=")[1]) || 5;
const VERBOSE = args.includes("--verbose");
const SAVE = args.find((a) => a.startsWith("--save="))?.split("=")[1];

const set = JSON.parse(fs.readFileSync(new URL("../eval/queries.json", import.meta.url), "utf8"));

// bookmark_id → [repo_slug]: un bookmark que enlaza al repo esperado también acierta.
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: links, error } = await db.from("bookmark_github_repos").select("bookmark_id, repo_slug").limit(10000);
if (error) throw new Error(error.message);
const repoOfBookmark = new Map();
for (const l of links) {
  const k = String(l.bookmark_id);
  repoOfBookmark.set(k, [...(repoOfBookmark.get(k) || []), l.repo_slug.toLowerCase()]);
}

const repoRefs = (r) =>
  r.source_type === "readme"
    ? [String(r.item_id).toLowerCase()]
    : repoOfBookmark.get(String(r.item_id)) || [];

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "0.0");

async function run(q) {
  const res = await ragSearch(q, { topK: TOP, log: false });
  const ids = res.results.map((r) => `${r.source_type}:${r.item_id}`);
  return {
    results: res.results,
    dup: new Set(ids).size < ids.length,
    lowRelevance: res.lowRelevance ?? false,
    latency: res.latency_ms,
  };
}

const rows = [];
let hit3 = 0;
let hit5 = 0;
let mrr = 0;
for (const { q, expect } of set.labeled) {
  const r = await run(q);
  const want = new Set(expect.map((s) => s.toLowerCase()));
  const pos = r.results.findIndex((x) => repoRefs(x).some((s) => want.has(s)));
  if (pos >= 0 && pos < 3) hit3++;
  if (pos >= 0 && pos < 5) hit5++;
  if (pos >= 0) mrr += 1 / (pos + 1);
  rows.push({ q, labeled: true, pos, ...r });
  if (VERBOSE || pos < 0) {
    const top = r.results
      .slice(0, 3)
      .map((x) => `${x.source_type === "readme" ? "📦" : "🔖"}${String(x.item_id).slice(0, 32)}(${x.score.toFixed(2)})`)
      .join(" ");
    console.log(`${pos >= 0 ? `✓ #${pos + 1}` : "✗ —"}  ${q.padEnd(24)} ${top}`);
  }
}
for (const q of set.unlabeled) rows.push({ q, labeled: false, ...(await run(q)) });

const n = set.labeled.length;
const all = rows.length;
const summary = {
  top: TOP,
  labeled: n,
  hit3: +pct(hit3, n),
  hit5: +pct(hit5, n),
  mrr: +(mrr / n).toFixed(3),
  queries: all,
  dupRate: +pct(rows.filter((r) => r.dup).length, all),
  emptyRate: +pct(rows.filter((r) => r.results.length === 0).length, all),
  lowRelevanceRate: +pct(rows.filter((r) => r.lowRelevance).length, all),
  avgResults: +(rows.reduce((s, r) => s + r.results.length, 0) / all).toFixed(2),
  avgLatencyMs: Math.round(rows.reduce((s, r) => s + r.latency, 0) / all),
};

console.log(`\n── Etiquetadas (${n}): hit@3 ${summary.hit3}% · hit@5 ${summary.hit5}% · MRR ${summary.mrr}`);
console.log(
  `── Todas (${all}): duplicados ${summary.dupRate}% · sin resultados ${summary.emptyRate}% · ` +
    `baja relevancia ${summary.lowRelevanceRate}% · ${summary.avgResults} resultados/consulta · ${summary.avgLatencyMs} ms`
);

if (SAVE) {
  fs.writeFileSync(
    SAVE,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        summary,
        rows: rows.map((r) => ({
          q: r.q,
          pos: r.pos,
          low: r.lowRelevance,
          results: r.results.map((x) => ({ t: x.source_type, id: x.item_id, s: +x.score.toFixed(4) })),
        })),
      },
      null,
      1
    )
  );
  console.log(`Guardado en ${SAVE}`);
}
process.exit(0);
