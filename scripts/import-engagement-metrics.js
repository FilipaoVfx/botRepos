// Trust Score — Fase 1.2: importador de métricas de engagement desde CSV.
//
// Lee el CSV de Twitter Analytics agregado por repo (p.ej. github_repos_metrics.csv),
// calcula el trust_score con la fórmula versionada de rag-orchestrator.js y hace
// UPSERT en public.repo_engagement_metrics (conflicto por repo_slug).
//
// Uso:
//   node scripts/import-engagement-metrics.js ./github_repos_metrics.csv
//
// Coherencia con la DB: repo_engagement_metrics tiene FK a github_repo_readmes.
// Para no chocar con esa FK, sólo se importan los repos que ya existen en el
// índice; los que no, se reportan como "omitidos".

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { computeTrustScore, TRUST_SCORE_VERSION } from "../src/rag-orchestrator.js";

dotenv.config();

// ─── CSV parsing (RFC4180-ish: comillas, comas y "" escapadas) ───────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* ignore */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// CSV header (normalizado) → columna de la tabla. Alias tolerantes.
const FIELD_MAP = {
  repo_slug: "repo_slug", slug: "repo_slug", repo: "repo_slug",
  source_url: "source_url", url: "source_url", tweet_url: "source_url",
  mentions_count: "mentions_count", mentions: "mentions_count", tweet_count: "mentions_count",
  avg_likes: "avg_likes", likes: "avg_likes", likes_avg: "avg_likes",
  avg_impressions: "avg_impressions", impressions: "avg_impressions", impressions_avg: "avg_impressions",
  avg_interactions: "avg_interactions", interactions: "avg_interactions",
  avg_saves: "avg_saves", saves: "avg_saves", bookmarks: "avg_saves",
  avg_shares: "avg_shares", shares: "avg_shares",
  avg_replies: "avg_replies", replies: "avg_replies",
  avg_reposts: "avg_reposts", reposts: "avg_reposts", retweets: "avg_reposts",
  avg_profile_visits: "avg_profile_visits", profile_visits: "avg_profile_visits",
  avg_url_clicks: "avg_url_clicks", url_clicks: "avg_url_clicks",
  avg_engagement_rate: "avg_engagement_rate", engagement_rate: "avg_engagement_rate",
  avg_like_rate: "avg_like_rate", like_rate: "avg_like_rate",
};

const NUMERIC_COLS = new Set([
  "mentions_count", "avg_likes", "avg_impressions", "avg_interactions", "avg_saves",
  "avg_shares", "avg_replies", "avg_reposts", "avg_profile_visits", "avg_url_clicks",
  "avg_engagement_rate", "avg_like_rate",
]);

function toRow(csvRow) {
  const out = {};
  for (const [rawKey, val] of Object.entries(csvRow)) {
    const col = FIELD_MAP[norm(rawKey)];
    if (!col) continue;
    if (NUMERIC_COLS.has(col)) {
      const n = parseFloat(String(val).replace(/[%,]/g, ""));
      out[col] = Number.isFinite(n) ? n : 0;
    } else {
      out[col] = String(val).trim();
    }
  }
  return out;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Uso: node scripts/import-engagement-metrics.js <ruta.csv>");
    process.exit(1);
  }
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    console.error(`No existe el CSV: ${abs}`);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno (.env)");
    process.exit(1);
  }
  const db = createClient(url, key);

  const parsed = parseCsv(fs.readFileSync(abs, "utf8"));
  console.log(`[import] ${parsed.length} filas leídas de ${path.basename(abs)}`);

  // Construir filas válidas (con repo_slug + source_url).
  const rows = [];
  let skippedNoSlug = 0;
  for (const r of parsed) {
    const row = toRow(r);
    if (!row.repo_slug) { skippedNoSlug++; continue; }
    if (!row.source_url) row.source_url = `https://github.com/${row.repo_slug}`;
    row.trust_score = computeTrustScore(row);
    row.trust_score_version = TRUST_SCORE_VERSION;
    row.updated_at = new Date().toISOString();
    rows.push(row);
  }

  // Filtrar a repos que existen en github_repo_readmes (respeta la FK).
  const existing = new Set();
  {
    const slugs = [...new Set(rows.map((r) => r.repo_slug))];
    for (let i = 0; i < slugs.length; i += 500) {
      const { data } = await db
        .from("github_repo_readmes")
        .select("repo_slug")
        .in("repo_slug", slugs.slice(i, i + 500));
      for (const d of data || []) existing.add(d.repo_slug);
    }
  }
  const importable = rows.filter((r) => existing.has(r.repo_slug));
  const skippedFk = rows.length - importable.length;

  // UPSERT por lotes.
  let upserted = 0;
  for (let i = 0; i < importable.length; i += 500) {
    const chunk = importable.slice(i, i + 500);
    const { error } = await db
      .from("repo_engagement_metrics")
      .upsert(chunk, { onConflict: "repo_slug" });
    if (error) {
      console.error(`[import] error en lote ${i}-${i + chunk.length}: ${error.message}`);
    } else {
      upserted += chunk.length;
    }
  }

  console.log(
    `[import] OK · upserted=${upserted} · omitidos(sin slug)=${skippedNoSlug} · ` +
    `omitidos(no en índice)=${skippedFk} · versión fórmula=${TRUST_SCORE_VERSION}`
  );
}

main().catch((e) => {
  console.error("[import] fallo:", e.message);
  process.exit(1);
});
