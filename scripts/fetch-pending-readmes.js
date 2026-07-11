import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

// Baja el README de los repos en github_repo_readmes con status pending/error
// y los deja en 'ok' para que rag-ingest.js readmes los indexe en Pinecone.
// Pensado para el cron de GitHub Actions (corre antes del ingest).
//
//   node scripts/fetch-pending-readmes.js [--limit=50] [--include-not-found]
//
// GITHUB_README_TOKEN (o GITHUB_TOKEN) opcional: sube el rate limit de 60/h a 5000/h.

const MAX_CHARS = Number(process.env.GITHUB_README_MAX_CHARS) || 300_000;
const args = process.argv.slice(2);
const includeNotFound = args.includes("--include-not-found");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = Math.max(1, Number(limitArg?.slice("--limit=".length)) || 50);

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY requeridas");
  return createClient(url, key);
}

async function fetchReadme(slug, token) {
  const headers = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "botrepos-readme-fetcher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const now = new Date().toISOString();
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/readme`, { headers });
    if (!res.ok) {
      return {
        status: res.status === 404 ? "not_found" : "error",
        content: null,
        content_chars: 0,
        error_message: `HTTP ${res.status}`,
        error_status: res.status,
        fetched_at: now,
        updated_at: now,
      };
    }
    let content = await res.text();
    const truncated = content.length > MAX_CHARS;
    if (truncated) content = content.slice(0, MAX_CHARS);
    return {
      status: "ok",
      content,
      content_chars: content.length,
      content_truncated: truncated,
      error_message: null,
      error_status: null,
      fetched_at: now,
      updated_at: now,
    };
  } catch (err) {
    return {
      status: "error",
      content: null,
      content_chars: 0,
      error_message: String(err?.message || err).slice(0, 300),
      error_status: null,
      fetched_at: now,
      updated_at: now,
    };
  }
}

async function main() {
  const db = getSupabase();
  const token = process.env.GITHUB_README_TOKEN || process.env.GITHUB_TOKEN || "";
  const statuses = includeNotFound ? ["pending", "error", "not_found"] : ["pending", "error"];

  const { data, error } = await db
    .from("github_repo_readmes")
    .select("repo_slug,status")
    .in("status", statuses)
    .limit(LIMIT);
  if (error) throw new Error(`listar pendientes: ${error.message}`);

  const slugs = (data || []).map((r) => r.repo_slug).filter(Boolean);
  console.log(`[readmes] pendientes (${statuses.join(",")}): ${slugs.length} (límite ${LIMIT})${token ? "" : " — SIN token, rate limit 60/h"}`);

  let ok = 0, notFound = 0, failed = 0;
  for (const slug of slugs) {
    const row = await fetchReadme(slug, token);
    const { error: upErr } = await db
      .from("github_repo_readmes")
      .update(row)
      .eq("repo_slug", slug);
    if (upErr) {
      failed++;
      console.error(`[readmes] update ${slug}: ${upErr.message}`);
      continue;
    }
    if (row.status === "ok") ok++;
    else if (row.status === "not_found") notFound++;
    else failed++;
    console.log(`[readmes] ${slug} -> ${row.status}${row.content_chars ? ` (${row.content_chars} chars)` : ""}`);
  }

  console.log(`[readmes] listo: ok=${ok} not_found=${notFound} error=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[readmes] falló:", e.message);
    process.exit(1);
  });
