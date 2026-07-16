import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

// Reporta bookmarks "densos" (texto con cue tipo "REPOOO👇" que manda al
// recurso al primer comentario) guardados sin link de GitHub ni en links ni
// en first_comment_links: el reply no existía al capturar o el lookup del
// tab de detalle falló, y el dedupe de la ingesta impide reintentarlos.
//
// Solo observabilidad (corre cada 6h en rag-ingest.yml). La recuperación la
// hace la extensión indexbook: pase de re-lookup (alarm cada 6h, tras el
// scanner import, o mensaje RELOOKUP_DENSE) + PATCH
// /api/bookmarks/first-comment-links en el backend.
//
//   node scripts/report-dense-missing-links.js [--user=local-user] [--limit=100] [--json]
//
// Nunca sale con código != 0: un fallo aquí no puede tumbar el workflow.

const args = process.argv.slice(2);
const userArg = args.find((a) => a.startsWith("--user="));
const USER_ID = userArg ? userArg.slice("--user=".length) : "local-user";
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = Math.max(1, Number(limitArg?.slice("--limit=".length)) || 100);
const AS_JSON = args.includes("--json");

// Mismos criterios que isDenseBookmarkMissingRepoLink en
// indexbook/backend/src/store.js — mantener en sync.
const DENSE_FIRST_COMMENT_RE = /\b((?:1st|first)\s+(?:comment|reply)|primer\s+comentario|primera\s+respuesta|en\s+comentarios|en\s+las?\s+respuestas|in\s+the\s+comments|in\s+replies|reply\s+below|comments?\s+below)\b/i;
const DENSE_DOWNWARD_RE = /(?:\u{1F447}|⬇|↓|\bbelow\b|\babajo\b|\bdown\b)/iu;
const DENSE_RESOURCE_RE = /\b(rep(?:o+|ository)|github|links?|enlaces?|codigo|code|source|demo|gist|tutorial)\b/i;
const GITHUB_LINK_RE = /(?:^|\/\/)(?:www\.)?github\.com\//i;

function normalizeDenseText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function isDenseBookmarkMissingRepoLink(row) {
  const text = normalizeDenseText(row?.text_content);
  if (!text) return false;

  const cued =
    DENSE_FIRST_COMMENT_RE.test(text) ||
    (DENSE_DOWNWARD_RE.test(text) && DENSE_RESOURCE_RE.test(text));
  if (!cued) return false;

  const pools = [
    ...(Array.isArray(row?.links) ? row.links : []),
    ...(Array.isArray(row?.first_comment_links) ? row.first_comment_links : []),
  ];
  return !pools.some((url) => GITHUB_LINK_RE.test(String(url || "")));
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY requeridas");
  return createClient(url, key);
}

async function main() {
  const db = getSupabase();
  const pageSize = 500;
  const dense = [];
  let scanned = 0;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from("bookmarks")
      .select(
        "id,tweet_id,text_content,author_username,source_url,links,first_comment_links,created_at"
      )
      .eq("user_id", USER_ID)
      .order("created_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(error.message);
    const rows = data || [];
    scanned += rows.length;

    for (const row of rows) {
      if (dense.length >= LIMIT) break;
      if (isDenseBookmarkMissingRepoLink(row)) dense.push(row);
    }

    if (rows.length < pageSize || dense.length >= LIMIT) break;
  }

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        { user_id: USER_ID, scanned, dense: dense.length, items: dense },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `[dense-report] ${dense.length} densos sin link de GitHub (user ${USER_ID}, ${scanned} filas escaneadas)`
  );
  for (const row of dense) {
    const url = row.source_url || `https://x.com/i/web/status/${row.tweet_id}`;
    const snippet = String(row.text_content || "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`  - ${row.tweet_id} @${row.author_username || "?"} ${url}`);
    console.log(`      "${snippet}"`);
  }
  if (dense.length > 0) {
    console.log(
      "[dense-report] recuperación: la extensión indexbook corre el pase de re-lookup y parchea vía PATCH /api/bookmarks/first-comment-links."
    );
  }
}

main().catch((err) => {
  console.error("[dense-report] fallo (no bloquea el workflow):", err?.message || err);
  process.exitCode = 0;
});
