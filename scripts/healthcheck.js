import dotenv from "dotenv";
dotenv.config({ quiet: true });

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { getPineconeStats } from "../src/rag-pinecone.js";
import { notify } from "./notify.js";

// Chequeo de salud del bot (lo corre botrepos-salud.timer cada 5 min).
//
// Cada chequeo devuelve { ok, detail }. El estado se guarda en
// $STATE_DIR/health.json y SOLO se avisa por Telegram en las transiciones
// (ok → falla y falla → ok), así una caída larga no manda un mensaje cada 5 min.
// Los reinicios de PM2 son un evento, no una condición: se avisan una vez, sin
// "recuperado".
//
//   node scripts/healthcheck.js [--dry-run]   (--dry-run: imprime, no avisa ni guarda)
//
// Nunca sale != 0 por un chequeo fallido: la alerta va por Telegram, no por
// OnFailure (evita alertas duplicadas o en bucle).

const execP = promisify(exec);
const DRY_RUN = process.argv.includes("--dry-run");

const STATE_DIR = process.env.STATE_DIRECTORY || "/var/lib/botrepos";
const STATE_FILE = path.join(STATE_DIR, "health.json");
const PM2_APP = process.env.PM2_APP_NAME || "telegram-rag-bot";
const INGEST_MAX_AGE_H = Number(process.env.INGEST_MAX_AGE_H) || 13;
const MIN_AVAILABLE_MB = Number(process.env.MIN_AVAILABLE_MB) || 300;
const FRESHNESS_DAYS = Number(process.env.FRESHNESS_DAYS) || 14;
const TIMEOUT_MS = 10_000;

const ok = (detail = "") => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    // unref: el timer pendiente no debe mantener vivo el proceso al terminar.
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms).unref()),
  ]);
}

// ─── Chequeos ────────────────────────────────────────────────────────

async function checkPm2() {
  const { stdout } = await execP("pm2 jlist", { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  const app = JSON.parse(stdout).find((p) => p.name === PM2_APP);
  if (!app) return { result: fail(`proceso ${PM2_APP} no existe en PM2`), restarts: null };
  const status = app.pm2_env?.status;
  const restarts = app.pm2_env?.restart_time ?? 0;
  return {
    result: status === "online" ? ok(`online, ${restarts} reinicios`) : fail(`estado PM2: ${status}`),
    restarts,
  };
}

async function checkHttp() {
  const port = process.env.PORT || process.env.DASHBOARD_PORT;
  if (!port) return ok("dashboard deshabilitado (sin PORT)");
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res.ok ? ok(`:${port}/healthz 200`) : fail(`:${port}/healthz respondió ${res.status}`);
}

async function checkTelegram() {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await res.json();
  return j.ok ? ok(`@${j.result.username}`) : fail(`getMe: ${j.description}`);
}

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function checkSupabase() {
  const { count, error } = await supabase().from("bookmarks").select("*", { count: "exact", head: true });
  return error ? fail(`Supabase: ${error.message}`) : ok(`${count} bookmarks`);
}

async function checkPinecone() {
  const stats = await getPineconeStats();
  const n = stats.totalRecordCount ?? stats.totalVectorCount;
  return n > 0 ? ok(`${n} vectores`) : fail(`Pinecone sin vectores (${n})`);
}

// Solo la antigüedad: si la corrida falla ya avisa OnFailure del timer. Esto
// detecta el caso silencioso (timer desactivado o colgado).
function checkIngest() {
  let last;
  try {
    last = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "last-ingest.json"), "utf8"));
  } catch {
    return fail("no hay last-ingest.json (¿nunca corrió la ingesta?)");
  }
  const ageH = (Date.now() - new Date(last.finished_at).getTime()) / 3_600_000;
  return ageH <= INGEST_MAX_AGE_H
    ? ok(`última hace ${ageH.toFixed(1)} h (${last.status})`)
    : fail(`la última ingesta terminó hace ${ageH.toFixed(0)} h (máx ${INGEST_MAX_AGE_H} h)`);
}

function checkMemory() {
  const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
  const mb = m ? Math.round(Number(m[1]) / 1024) : null;
  if (mb == null) return ok("MemAvailable no disponible");
  return mb >= MIN_AVAILABLE_MB ? ok(`${mb} MB disponibles`) : fail(`RAM disponible baja: ${mb} MB (< ${MIN_AVAILABLE_MB})`);
}

// Informativo: el indexer dejó de alimentar bookmarks. No es un fallo del bot.
async function checkFreshness() {
  const { data, error } = await supabase()
    .from("bookmarks")
    .select("inserted_at")
    .not("inserted_at", "is", null)
    .order("inserted_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const last = data?.[0]?.inserted_at;
  if (!last) return fail("no hay bookmarks con inserted_at");
  const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
  return days <= FRESHNESS_DAYS
    ? ok(`último bookmark hace ${days.toFixed(1)} días`)
    : fail(`sin bookmarks nuevos hace ${days.toFixed(0)} días (desde ${last.slice(0, 10)}): el indexer no está capturando`);
}

const LABELS = {
  bot: "Bot (PM2)",
  http: "Dashboard /healthz",
  telegram: "Telegram",
  supabase: "Supabase",
  pinecone: "Pinecone",
  ingesta: "Ingesta",
  memoria: "Memoria del host",
  frescura: "Contenido nuevo",
};

async function run(fn) {
  try {
    return await withTimeout(Promise.resolve().then(fn));
  } catch (err) {
    return fail(err.message);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

let pm2Restarts = null;
const checks = {
  bot: async () => {
    const r = await checkPm2();
    pm2Restarts = r.restarts;
    return r.result;
  },
  http: checkHttp,
  telegram: checkTelegram,
  supabase: checkSupabase,
  pinecone: checkPinecone,
  ingesta: checkIngest,
  memoria: checkMemory,
  frescura: checkFreshness,
};
const results = Object.fromEntries(
  await Promise.all(Object.entries(checks).map(async ([k, fn]) => [k, await run(fn)]))
);

let prev = { checks: {}, restarts: null };
try {
  prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch {
  /* primera corrida: todo se compara contra "ok" */
}

const fallas = [];
const recuperados = [];
for (const [k, r] of Object.entries(results)) {
  const wasOk = prev.checks?.[k]?.ok ?? true;
  if (wasOk && !r.ok) fallas.push(`• ${LABELS[k]}: ${r.detail}`);
  if (!wasOk && r.ok) recuperados.push(`• ${LABELS[k]}: ${r.detail}`);
}
if (pm2Restarts != null && prev.restarts != null && pm2Restarts > prev.restarts) {
  fallas.push(`• ${LABELS.bot}: se reinició ${pm2Restarts - prev.restarts} vez/veces (total ${pm2Restarts}) → pm2 logs ${PM2_APP}`);
}

for (const [k, r] of Object.entries(results)) console.log(`${r.ok ? "✓" : "✗"} ${k}: ${r.detail}`);

if (DRY_RUN) {
  if (fallas.length) console.log(`\n[dry-run] avisaría:\n${fallas.join("\n")}`);
  if (recuperados.length) console.log(`\n[dry-run] avisaría recuperado:\n${recuperados.join("\n")}`);
} else {
  if (fallas.length) await notify(`🔴 Problema detectado\n${fallas.join("\n")}`);
  if (recuperados.length) await notify(`🟢 Recuperado\n${recuperados.join("\n")}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ checked_at: new Date().toISOString(), restarts: pm2Restarts ?? prev.restarts, checks: results }, null, 2)
  );
}
