import dotenv from "dotenv";
dotenv.config();

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────
// Concilia repos (mencionados en replies "link pelado") con su post PADRE.
//
//   node scripts/reconcile-repos.js <github_repos_completo.csv> [--dry-run]
//
// El reply donde vive el repo se postea segundos después del padre, así que
// el padre = el bookmark con id (snowflake) inmediatamente menor al del reply,
// dentro de un umbral de tiempo. Escribe:
//   - github_repo_readmes: siembra repo_slug (status pending) SIN pisar los ok
//   - bookmarks.first_comment_links del padre += repo_url
//   - bookmark_github_repos: link (padre, repo_slug)
// Los casos dudosos (sin padre cercano) van a reconcile-review.csv.
// ─────────────────────────────────────────────────────────────────────

const DELTA_MAX_MS = 600_000; // 10 min
const IMPORT_USER_ID = process.env.IMPORT_USER_ID || "x-csv-import";
const DRY = process.argv.includes("--dry-run");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY requeridas en .env");
  return createClient(url, key);
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c === "\r") {}
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const statusId = (u) => (String(u).match(/status\/(\d+)/) || [])[1] || "";

function parseRepo(url) {
  const m = String(url).match(/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i);
  if (!m) return null;
  const owner = m[1].replace(/\.git$/i, "");
  const repo = m[2].replace(/\.git$/i, "");
  return { owner, repo, slug: `${owner}/${repo}`.toLowerCase(), repo_url: `https://github.com/${owner}/${repo}` };
}

// nearest candidate id strictly below target (binary search over sorted BigInt[])
function nearestBelow(sorted, target) {
  let lo = 0, hi = sorted.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m].idBig < target) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans >= 0 ? sorted[ans] : null;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("Uso: node scripts/reconcile-repos.js <github_repos_completo.csv> [--dry-run]");
    process.exit(1);
  }

  const db = getSupabase();

  // 1. Cargar todos los bookmarks candidatos a padre (id numérico + fcl).
  const candidates = [];
  const byId = new Map();
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await db
        .from("bookmarks")
        .select("id,user_id,first_comment_links")
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`fetch bookmarks: ${error.message}`);
      const rows = data || [];
      for (const r of rows) {
        const idStr = String(r.id);
        if (!/^\d+$/.test(idStr)) continue;
        const rec = { idBig: BigInt(idStr), id: idStr, user_id: r.user_id, fcl: Array.isArray(r.first_comment_links) ? r.first_comment_links : [] };
        candidates.push(rec);
        byId.set(idStr, rec);
      }
      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }
  candidates.sort((a, b) => (a.idBig < b.idBig ? -1 : a.idBig > b.idBig ? 1 : 0));
  console.log(`[recon] bookmarks candidatos (id numérico): ${candidates.length}`);

  // 2. Leer CSV de repos y mapear cada uno a su padre.
  const gRows = parseCSV(fs.readFileSync(csvPath, "utf-8"));
  gRows.shift(); // header
  const review = [];
  const parentRepos = new Map(); // parentId -> { rec, repos: Map(slug -> repo_url) }
  const seedSlugs = new Map(); // slug -> {owner, repo, repo_url}  (TODOS los repos válidos)

  for (const r of gRows) {
    if (!r[0] || !r[1]) continue;
    const info = parseRepo(r[0].trim());
    const cid = statusId(r[1].trim());
    if (!info || !cid) { review.push([r[0], r[1], "repo/url inválido"]); continue; }

    // El README se siembra siempre (el conocimiento del repo no depende del padre).
    seedSlugs.set(info.slug, info);

    const parent = nearestBelow(candidates, BigInt(cid));
    if (!parent) { review.push([info.repo_url, r[1], "sin padre por debajo (link no creado)"]); continue; }
    const deltaMs = Number((BigInt(cid) - parent.idBig) >> 22n);
    if (deltaMs > DELTA_MAX_MS) {
      review.push([info.repo_url, r[1], `padre lejano +${(deltaMs / 1000).toFixed(0)}s -> ${parent.id} (link no creado)`]);
      continue;
    }

    let entry = parentRepos.get(parent.id);
    if (!entry) { entry = { rec: parent, repos: new Map() }; parentRepos.set(parent.id, entry); }
    entry.repos.set(info.slug, info.repo_url);
  }

  console.log(`[recon] repos válidos (README a sembrar): ${seedSlugs.size} slugs únicos`);
  console.log(`[recon] repos con padre confiable (a linkear): ${[...parentRepos.values()].reduce((n, e) => n + e.repos.size, 0)}`);
  console.log(`[recon] posts padre afectados: ${parentRepos.size}`);
  console.log(`[recon] casos a revisión (solo el link, README sí se siembra): ${review.length}`);

  // Build write payloads — README de TODOS los repos válidos.
  const readmeRows = [...seedSlugs.values()].map((i) => ({
    repo_slug: i.slug,
    owner: i.owner.toLowerCase(),
    repo: i.repo.toLowerCase(),
    repo_url: i.repo_url,
    status: "pending",
  }));
  const linkRows = [];
  const fclUpdates = [];
  for (const [parentId, entry] of parentRepos) {
    const newUrls = [...entry.repos.values()];
    const merged = [...new Set([...(entry.rec.fcl || []), ...newUrls])];
    fclUpdates.push({ id: parentId, first_comment_links: merged });
    for (const slug of entry.repos.keys()) {
      linkRows.push({ bookmark_id: parentId, user_id: entry.rec.user_id || IMPORT_USER_ID, repo_slug: slug });
    }
  }

  // review CSV
  const reviewPath = "reconcile-review.csv";
  if (review.length > 0) {
    const out = ["repo_url,source_url,motivo", ...review.map((x) => x.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    fs.writeFileSync(reviewPath, out, "utf-8");
    console.log(`[recon] revisión escrita en ${reviewPath}`);
  }

  if (DRY) {
    console.log("\n[recon] DRY-RUN — no se escribió en la DB. Resumen:");
    console.log(`  github_repo_readmes a sembrar: ${readmeRows.length}`);
    console.log(`  bookmarks (padre) a actualizar first_comment_links: ${fclUpdates.length}`);
    console.log(`  bookmark_github_repos a linkear: ${linkRows.length}`);
    console.log("  ejemplo link:", JSON.stringify(linkRows[0]));
    process.exit(0);
  }

  // 3a. Sembrar github_repo_readmes SIN pisar existentes (ignoreDuplicates).
  let seeded = 0;
  for (let i = 0; i < readmeRows.length; i += 200) {
    const batch = readmeRows.slice(i, i + 200);
    const { error } = await db.from("github_repo_readmes").upsert(batch, { onConflict: "repo_slug", ignoreDuplicates: true });
    if (error) console.error(`[recon] readmes lote ${i / 200}: ${error.message}`);
    else seeded += batch.length;
  }
  console.log(`[recon] github_repo_readmes upsert (ignoreDuplicates): ${seeded}`);

  // 3b. Actualizar first_comment_links de cada padre.
  let updated = 0, updErr = 0;
  for (const u of fclUpdates) {
    const { error } = await db.from("bookmarks").update({ first_comment_links: u.first_comment_links }).eq("id", u.id);
    if (error) { updErr++; if (updErr <= 3) console.error(`[recon] update fcl ${u.id}: ${error.message}`); }
    else updated++;
  }
  console.log(`[recon] first_comment_links actualizados: ${updated} (errores: ${updErr})`);

  // 3c. Linkear bookmark_github_repos.
  let linked = 0;
  for (let i = 0; i < linkRows.length; i += 200) {
    const batch = linkRows.slice(i, i + 200);
    const { error } = await db.from("bookmark_github_repos").upsert(batch, { onConflict: "bookmark_id,repo_slug", ignoreDuplicates: true });
    if (error) console.error(`[recon] links lote ${i / 200}: ${error.message}`);
    else linked += batch.length;
  }
  console.log(`[recon] bookmark_github_repos upsert: ${linked}`);

  console.log("\n[recon] Listo. Siguientes pasos:");
  console.log("  1) node src/rag-ingest.js bookmarks --user=x-csv-import   (re-embebe padres con el repo)");
  console.log("  2) (en indexbook) descargar READMEs de los repos pending y luego ingest:readmes");
  process.exit(0);
}

main().catch((e) => { console.error("[recon] Falló:", e.message); process.exit(1); });
