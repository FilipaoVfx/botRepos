// Durable event spool — a tiny write-ahead log so observability events survive
// process restarts, crashes and transient Supabase outages.
//
// Flow: spoolEvent() appends the row to a local JSONL file *synchronously* (so
// it is on disk before we ever attempt a network write). A background flusher
// drains the log into Supabase with retries, and replays anything left over on
// startup. Nothing is inserted twice: each line lives in exactly one batch file
// (rotated via atomic rename) and is deleted only after a successful insert.

import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const WAL = path.join(LOG_DIR, "events.wal.jsonl");
const BATCH_SUFFIX = ".batch";

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Durable, synchronous append. Never throws to the caller.
export function spoolEvent(row) {
  try {
    ensureDir();
    fs.appendFileSync(WAL, JSON.stringify(row) + "\n");
  } catch {
    // Disk full / permissions — nothing more we can safely do here.
  }
}

let flushing = false;

// Drain the WAL (and any leftover batch files) into Supabase.
// Serialized via `flushing` so overlapping ticks don't double-process a batch.
export async function flushEvents(db) {
  if (flushing) return;
  flushing = true;
  try {
    ensureDir();

    // Rotate the live WAL to an immutable batch file via atomic rename, so new
    // appends land in a fresh WAL and we never read a moving target.
    if (fs.existsSync(WAL) && fs.statSync(WAL).size > 0) {
      const batch = path.join(
        LOG_DIR,
        `events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${BATCH_SUFFIX}`
      );
      fs.renameSync(WAL, batch);
    }

    const batches = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(BATCH_SUFFIX))
      .sort(); // oldest first (timestamp-prefixed)

    for (const f of batches) {
      const fp = path.join(LOG_DIR, f);
      let rows;
      try {
        rows = fs
          .readFileSync(fp, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        continue; // unreadable/corrupt — leave it for manual inspection
      }
      if (!rows.length) {
        fs.unlinkSync(fp);
        continue;
      }

      // All-or-nothing per batch so a retry never duplicates rows.
      const { error } = await db.from("events").insert(rows);
      if (error) {
        // Isolate a possible poison row: retry individually, keep only the
        // rows that still fail so the rest of the queue can drain.
        const failed = [];
        for (const r of rows) {
          const { error: e2 } = await db.from("events").insert(r);
          if (e2) failed.push(r);
        }
        if (failed.length) {
          fs.writeFileSync(fp, failed.map((r) => JSON.stringify(r)).join("\n") + "\n");
        } else {
          fs.unlinkSync(fp);
        }
      } else {
        fs.unlinkSync(fp);
      }
    }
  } catch {
    // Never let flushing crash the caller; retry on the next tick.
  } finally {
    flushing = false;
  }
}

let timer = null;

// Start periodic flushing + an immediate startup replay of anything pending.
export function startEventFlusher(db, { intervalMs = 3000 } = {}) {
  flushEvents(db).catch(() => {});
  timer = setInterval(() => flushEvents(db).catch(() => {}), intervalMs);
  timer.unref?.(); // don't keep the event loop alive on its own
  return timer;
}

// Count of not-yet-flushed events still sitting on disk (for diagnostics).
export function pendingEventCount() {
  try {
    let n = 0;
    const files = fs.existsSync(WAL) ? [WAL] : [];
    for (const f of fs.readdirSync(LOG_DIR).filter((x) => x.endsWith(BATCH_SUFFIX))) {
      files.push(path.join(LOG_DIR, f));
    }
    for (const f of files) {
      n += fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length;
    }
    return n;
  } catch {
    return 0;
  }
}
