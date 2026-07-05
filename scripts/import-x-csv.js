import dotenv from "dotenv";
dotenv.config();

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────
// Importa un export de analíticas de X (posts propios) a la tabla
// `bookmarks` de Supabase, para luego indexarlos con `npm run ingest`.
//
//   node scripts/import-x-csv.js "ruta/al/export.csv"
//
// Idempotente: hace upsert por `tweet_id` (no duplica al re-ejecutar).
// ─────────────────────────────────────────────────────────────────────

const MIN_TEXT_CHARS = 40; // descarta posts triviales ("Buenos días!!") como ruido
const BATCH_SIZE = 200;
// user_id propio para diferenciar estos posts (import CSV) de los capturados
// por la extensión. Cambiable con la env var IMPORT_USER_ID.
const IMPORT_USER_ID = process.env.IMPORT_USER_ID || "x-csv-import";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas en .env");
  }
  return createClient(url, key);
}

// Parser CSV correcto (RFC-4180): soporta comillas, comas y saltos de
// línea dentro de campos entrecomillados, y comillas escapadas ("").
function parseCSV(text) {
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
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // ignora CR (se maneja con el \n)
    } else {
      field += c;
    }
  }
  // último campo/fila si el archivo no termina en newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseDate(raw) {
  // "Sat, Apr 25, 2026" → ISO
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function usernameFromUrl(url) {
  const m = (url || "").match(/(?:x|twitter)\.com\/([^/]+)\/status/i);
  return m ? m[1] : "";
}

function extractLinks(text) {
  const matches = (text || "").match(/https?:\/\/[^\s]+/gi) || [];
  return [...new Set(matches)];
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Uso: node scripts/import-x-csv.js "ruta/al/export.csv"');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`No existe el archivo: ${csvPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(raw);
  const header = rows.shift();

  // localiza columnas por nombre (robusto ante reordenamientos)
  const col = (name) => header.findIndex((h) => h.trim() === name);
  const iId = col("ID del post");
  const iFecha = col("Fecha");
  const iTexto = col("Texto del post");
  const iEnlace = col("Postear enlace");

  if (iId < 0 || iTexto < 0) {
    console.error("El CSV no tiene las columnas esperadas ('ID del post', 'Texto del post').");
    console.error("Header encontrado:", header.join(" | "));
    process.exit(1);
  }

  const seen = new Set();
  const bookmarks = [];
  let skippedShort = 0;

  for (const r of rows) {
    if (!r || r.length < header.length) continue;
    const tweetId = (r[iId] || "").trim();
    const text = (r[iTexto] || "").trim();
    const url = iEnlace >= 0 ? (r[iEnlace] || "").trim() : "";

    if (!tweetId || !text) continue;
    if (text.replace(/https?:\/\/\S+/g, "").trim().length < MIN_TEXT_CHARS) {
      skippedShort++;
      continue;
    }
    if (seen.has(tweetId)) continue;
    seen.add(tweetId);

    const username = usernameFromUrl(url);
    bookmarks.push({
      id: tweetId,
      user_id: IMPORT_USER_ID,
      tweet_id: tweetId,
      text_content: text,
      source_url: url,
      author_username: username,
      author_name: username,
      links: extractLinks(text),
      first_comment_links: [],
      created_at: parseDate(iFecha >= 0 ? r[iFecha] : ""),
    });
  }

  console.log(`[import] Filas: ${rows.length} | válidas: ${bookmarks.length} | descartadas por cortas: ${skippedShort}`);
  console.log(`[import] user_id para este lote: "${IMPORT_USER_ID}"`);

  const db = getSupabase();
  let inserted = 0;
  let existing = 0;
  let errors = 0;

  // La tabla no tiene UNIQUE(tweet_id), así que deduplicamos a mano:
  // consultamos cuáles tweet_id ya están y solo insertamos los nuevos.
  for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const ids = batch.map((b) => b.tweet_id);

    const { data: rows, error: selErr } = await db
      .from("bookmarks")
      .select("tweet_id")
      .in("tweet_id", ids);

    if (selErr) {
      console.error(`[import] Error consultando existentes: ${selErr.message}`);
    }
    const present = new Set((rows || []).map((r) => String(r.tweet_id)));
    const toInsert = batch.filter((b) => !present.has(String(b.tweet_id)));
    existing += batch.length - toInsert.length;

    if (toInsert.length === 0) {
      console.log(`[import] Lote ${i / BATCH_SIZE}: 0 nuevos (ya existían)`);
      continue;
    }

    const { error } = await db.from("bookmarks").insert(toInsert);
    if (error) {
      errors += toInsert.length;
      console.error(`[import] Error insert lote ${i / BATCH_SIZE}: ${error.message}`);
    } else {
      inserted += toInsert.length;
      console.log(`[import] Insertados ${inserted} (+${toInsert.length})`);
    }
  }

  console.log(`\n[import] Listo. Insertados: ${inserted}, ya existían: ${existing}, errores: ${errors}`);
  console.log(`[import] Ahora corre:  npm run ingest:bookmarks`);
}

main().catch((err) => {
  console.error("[import] Falló:", err.message);
  process.exit(1);
});
