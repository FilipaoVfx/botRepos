import os from "os";
import {
  ragSearch,
  getKnowledgeStats,
  listRepos,
  searchRepos,
  getRepoDetail,
  getQueryAnalytics,
  startEventLog,
  refreshRepoTrust,
  TRUST_SCORE_VERSION,
} from "./rag-orchestrator.js";
import { getPineconeStats, getPineconeConfig } from "./rag-pinecone.js";
import { startDashboard } from "./dashboard.js";

const REPOS_PAGE_SIZE = 5;

// Extract the user/chat context that Telegram's Bot API exposes on a message
// (message.from + chat). This is only what the user voluntarily sends by
// messaging the bot — no phone number, no scraping, nothing beyond the API.
// Passed to the RAG layer for the observability `events` log.
function tgUser(ctx) {
  const f = ctx?.from;
  if (!f) return null;
  return {
    id: f.id ?? null,
    username: f.username ?? null,
    first_name: f.first_name ?? null,
    last_name: f.last_name ?? null,
    language_code: f.language_code ?? null,
    is_premium: f.is_premium ?? null,
    is_bot: f.is_bot ?? null,
    chat_id: ctx.chat?.id ?? null,
    chat_type: ctx.chat?.type ?? null,
  };
}

// Map short ids <-> repo slugs so inline-button callback_data stays well under
// Telegram's 64-byte limit even for long owner/repo slugs.
const slugById = new Map();
const idBySlug = new Map();
let slugSeq = 0;
function idForSlug(slug) {
  if (idBySlug.has(slug)) return idBySlug.get(slug);
  const id = (slugSeq++).toString(36);
  idBySlug.set(slug, id);
  slugById.set(id, slug);
  return id;
}

// Trust Score badge — a compact reliability marker shown next to a repo. Only
// rendered when the repo has engagement metrics; degrades to "" otherwise, so
// repos without a score (or before the CSV import) render cleanly.
function trustBadge(score) {
  if (score == null || Number.isNaN(Number(score))) return "";
  const s = Number(score);
  const icon = s >= 8 ? "🟢" : s >= 6 ? "🔵" : s >= 4 ? "🟡" : s >= 2 ? "🟠" : "⚪";
  return ` · ${icon} ${s.toFixed(1)}/10 confianza`;
}

// Escape the few characters that break Telegram legacy Markdown.
function escapeMd(s) {
  return String(s ?? "").replace(/([_*`[\]])/g, "\\$1");
}

let bot = null;
let botUsername = "";
const BOT_STARTED_AT = Date.now();

// List of commands shown in the Telegram "/" menu (registered via setMyCommands)
const BOT_COMMANDS = [
  { command: "search", description: "Buscar en bookmarks y READMEs" },
  { command: "filter", description: "Filtrar: /filter <bookmark|readme> <query>" },
  { command: "repos", description: "Listar todos los repositorios" },
  { command: "buscar_repo", description: "Búsqueda semántica solo de repos" },
  { command: "status", description: "Estado del bot y del hosting" },
  { command: "data", description: "Estadísticas de la base de conocimiento" },
  { command: "insights", description: "Analítica de uso y brechas de contenido" },
  { command: "help", description: "Mostrar ayuda" },
];

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(" ");
}

function getBot() {
  if (bot) return bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return import("telegraf").then(async ({ Telegraf }) => {
    bot = new Telegraf(token);

    // Get bot username for group mentions
    const me = await bot.telegram.getMe();
    botUsername = me.username;

    // Register the command menu so Telegram's "/" button shows all commands
    try {
      await bot.telegram.setMyCommands(BOT_COMMANDS);
      console.log("[Telegram] Command menu registered");
    } catch (err) {
      console.error("[Telegram] Failed to register commands:", err.message);
    }

    return bot;
  });
}

function formatTelegramResults(results) {
  let response = `🔍 _${results.query}_\n`;
  response += `📊 ${results.total} resultados | ${results.latency_ms}ms\n`;
  response += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (results.results.length === 0) {
    response += "No se encontraron resultados.";
    return response;
  }

  results.results.forEach((r, i) => {
    const icon = r.source_type === "readme" ? "📦" : "🔖";
    const score = (r.score * 100).toFixed(0);

    // Extract repo name from URL if it's a GitHub repo
    let repoName = "";
    if (r.url && r.url.includes("github.com")) {
      const match = r.url.match(/github\.com\/([^/]+\/[^/]+)/);
      if (match) repoName = match[1];
    }

    const title = repoName || r.title.replace(/_/g, "\\_").replace(/\*/g, "\\*");
    response += `${icon} *${i + 1}. ${title}*\n`;
    response += `   📊 ${score}% relevancia\n`;

    if (r.url) response += `   🔗 [Abrir enlace](${r.url})\n`;
    if (r.author && r.author !== repoName) response += `   👤 ${r.author}\n`;
    if (r.tags && r.tags.length > 0) response += `   🏷️ ${r.tags.join(", ")}\n`;

    // Clean text - remove "Author:" and "URL:" lines
    let text = r.text
      .replace(/Author:.*?\n/g, "")
      .replace(/URL:.*?\n/g, "")
      .replace(/\n+/g, " ")
      .replace(/_/g, "\\_")
      .replace(/\*/g, "\\*")
      .trim();

    if (text.length > 150) text = text.slice(0, 147) + "...";
    response += `   📝 ${text}\n\n`;
  });

  return response;
}

// ─── Repos: list page ────────────────────────────────────────────────

async function buildReposPage(page) {
  const { repos, total, page: p, totalPages } = await listRepos({
    page,
    pageSize: REPOS_PAGE_SIZE,
  });

  let text =
    `📦 *Repositorios indexados* — ${total} en total\n` +
    `Página ${p}/${totalPages}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

  const detailRow = [];
  if (repos.length === 0) {
    text += "_No hay repositorios._";
  } else {
    repos.forEach((r, i) => {
      const n = (p - 1) * REPOS_PAGE_SIZE + i + 1;
      const url = r.repo_url || `https://github.com/${r.repo_slug}`;
      text += `*${n}.* [${escapeMd(r.repo_slug)}](${url})\n`;
      const chars = r.content_chars ? `📝 ${r.content_chars} chars` : "";
      const meta = `${chars}${trustBadge(r.trust_score)}`.replace(/^ · /, "");
      if (meta) text += `      ${meta}\n`;
      detailRow.push({
        text: `🔎 ${i + 1}`,
        callback_data: `rd:${idForSlug(r.repo_slug)}`,
      });
    });
  }

  const nav = [];
  if (p > 1) nav.push({ text: "⬅️ Anterior", callback_data: `rp:${p - 1}` });
  nav.push({ text: `${p}/${totalPages}`, callback_data: "noop" });
  if (p < totalPages) nav.push({ text: "Siguiente ➡️", callback_data: `rp:${p + 1}` });

  const inline_keyboard = [detailRow, nav].filter((row) => row.length > 0);
  return { text, keyboard: { inline_keyboard } };
}

// ─── Repos: semantic search results ──────────────────────────────────

function buildRepoSearchText(results) {
  let text =
    `🔎 _${escapeMd(results.query)}_\n` +
    `📦 ${results.total} repos | ${results.latency_ms}ms\n` +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

  if (results.results.length === 0) {
    text += "No se encontraron repositorios.";
    return text;
  }

  results.results.forEach((r, i) => {
    const score = (r.score * 100).toFixed(0);
    text +=
      `📦 *${i + 1}.* [${escapeMd(r.repo_slug)}](${r.url})\n` +
      `      📊 ${score}% relevancia${trustBadge(r.trust_score)}\n\n`;
  });

  return text;
}

function buildRepoSearchKeyboard(results) {
  const row = results.results.map((r, i) => ({
    text: `🔎 ${i + 1}`,
    callback_data: `rd:${idForSlug(r.repo_slug)}`,
  }));
  return row.length ? { inline_keyboard: [row] } : undefined;
}

// ─── Repos: detail (metadata + origin post) ──────────────────────────

function buildRepoDetail({ repo, origins, engagement }) {
  const url = repo.repo_url || `https://github.com/${repo.repo_slug}`;

  let text =
    `📦 *${escapeMd(repo.repo_slug)}*\n` +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    `👤 Owner: ${escapeMd(repo.owner || "—")}\n` +
    `📂 Repo: ${escapeMd(repo.repo || "—")}\n` +
    `🔗 [Ver en GitHub](${url})\n`;

  if (repo.readme_html_url) text += `📄 [README](${repo.readme_html_url})\n`;

  const sizeKb = repo.size_bytes ? ` · ${(repo.size_bytes / 1024).toFixed(1)} KB` : "";
  text += `📝 README: ${repo.content_chars ?? "?"} chars${sizeKb}\n`;
  if (repo.fetched_at) {
    text += `📅 Indexado: ${new Date(repo.fetched_at).toLocaleDateString("es-ES")}\n`;
  }

  // Trust Score — solo si el repo tiene métricas de engagement.
  if (repo.trust_score != null && engagement) {
    text +=
      `🛡️ *Trust Score:*${trustBadge(repo.trust_score)}\n` +
      `      ❤️ ${Math.round(engagement.avg_likes)} likes · ` +
      `🔖 ${Math.round(engagement.avg_saves)} saves · ` +
      `📈 ${Number(engagement.avg_engagement_rate).toFixed(1)}% eng · ` +
      `🔁 ${engagement.mentions_count} menciones\n`;
  }

  text += "\n*📌 Post(s) de origen*\n";
  if (!origins || origins.length === 0) {
    text += "_No se encontró el post de origen._";
  } else {
    origins.forEach((o, i) => {
      const author = o.author_username ? `@${o.author_username}` : o.author_name || "?";
      text += `${i + 1}. 👤 ${escapeMd(author)}`;
      if (o.source_url) text += ` — [Abrir post](${o.source_url})`;
      text += "\n";
      const snippet = (o.text_content || "").replace(/\s+/g, " ").trim().slice(0, 140);
      if (snippet) text += `      📝 ${escapeMd(snippet)}\n`;
    });
  }

  return text;
}

export async function startTelegramBot() {
  const telegramBot = await getBot();

  // /start
  telegramBot.start((ctx) => {
    ctx.reply(
      "📚 *Indexer RAG Bot*\n\n" +
        "Busca en tu base de conocimiento técnico.\n\n" +
        "*En chats privados:*\n" +
        "Escribe tu consulta directamente\n\n" +
        "*En grupos:*\n" +
        "Menciona al bot o responde a sus mensajes\n\n" +
        "*Comandos:*\n" +
        "/search <query> — Buscar en bookmarks y READMEs\n" +
        "/filter bookmark <query> — Buscar solo en bookmarks\n" +
        "/filter readme <query> — Buscar solo en READMEs\n" +
        "/repos — Listar todos los repositorios (paginado)\n" +
        "/buscar_repo <query> — Búsqueda semántica solo de repos\n" +
        "/status — Estado del bot y del hosting\n" +
        "/data — Estadísticas de la base de conocimiento\n" +
        "/insights — Analítica de uso y brechas de contenido\n" +
        "/help — Mostrar ayuda\n\n" +
        "*Ejemplos:*\n" +
        "→ react hooks patterns\n" +
        "/search ai agents tools\n" +
        "/filter readme supabase auth",
      { parse_mode: "Markdown" }
    );
  });

  // /help
  telegramBot.help((ctx) => {
    ctx.reply(
      "📚 *Indexer RAG Bot*\n\n" +
        "*Comandos:*\n" +
        "/search <query> — Buscar en bookmarks y READMEs\n" +
        "/filter bookmark <query> — Buscar solo en bookmarks\n" +
        "/filter readme <query> — Buscar solo en READMEs\n" +
        "/repos — Listar todos los repositorios (paginado)\n" +
        "/buscar_repo <query> — Búsqueda semántica solo de repos\n" +
        "/status — Estado del bot y del hosting\n" +
        "/data — Estadísticas de la base de conocimiento\n" +
        "/insights — Analítica de uso y brechas de contenido\n\n" +
        "*En grupos:*\n" +
        "Menciona al bot: @tu_bot \"query\"\n" +
        "O responde a un mensaje del bot\n\n" +
        "*Ejemplos:*\n" +
        "→ react hooks patterns\n" +
        "/search ai agents tools\n" +
        "/filter readme supabase auth\n\n" +
        "También puedes escribir directamente tu consulta.",
      { parse_mode: "Markdown" }
    );
  });

  // /search
  telegramBot.command("search", async (ctx) => {
    const query = ctx.message.text.replace("/search", "").trim();
    if (!query) {
      return ctx.reply("Usage: /search <your query>");
    }

    await ctx.replyWithChatAction("typing");

    try {
      const results = await ragSearch(query, { topK: 3, interface: "telegram", user: tgUser(ctx) });
      ctx.reply(formatTelegramResults(results), { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // /filter
  telegramBot.command("filter", async (ctx) => {
    const parts = ctx.message.text.replace("/filter", "").trim().split(" ");
    const sourceType = parts[0];
    const query = parts.slice(1).join(" ");

    if (!["bookmark", "readme"].includes(sourceType) || !query) {
      return ctx.reply("Usage: /filter <bookmark|readme> <query>");
    }

    await ctx.replyWithChatAction("typing");

    try {
      const results = await ragSearch(query, { topK: 5, sourceType, interface: "telegram", user: tgUser(ctx) });
      ctx.reply(formatTelegramResults(results), { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // /repos — paginated list of all indexed repos
  telegramBot.command("repos", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    try {
      const { text, keyboard } = await buildReposPage(1);
      ctx.reply(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // Pagination for /repos (edits the same message)
  telegramBot.action(/^rp:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1], 10);
    try {
      const { text, keyboard } = await buildReposPage(page);
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    } catch {
      // Ignore "message is not modified" and similar edit errors
    }
    ctx.answerCbQuery().catch(() => {});
  });

  // Page-indicator button — no-op
  telegramBot.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));

  // /buscar_repo — semantic search restricted to repos only
  telegramBot.command("buscar_repo", async (ctx) => {
    const query = ctx.message.text.replace(/^\/buscar_repo(@\w+)?/, "").trim();
    if (!query) {
      return ctx.reply("Uso: /buscar_repo <consulta>");
    }

    await ctx.replyWithChatAction("typing");

    try {
      const results = await searchRepos(query, { topK: 5, user: tgUser(ctx) });
      ctx.reply(buildRepoSearchText(results), {
        parse_mode: "Markdown",
        reply_markup: buildRepoSearchKeyboard(results),
        disable_web_page_preview: true,
      });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // Repo detail (metadata + origin post) triggered by the 🔎 detail buttons
  telegramBot.action(/^rd:(.+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const slug = slugById.get(ctx.match[1]);
    if (!slug) {
      return ctx.reply("⚠️ Sesión expirada. Vuelve a listar o buscar los repos.");
    }

    await ctx.replyWithChatAction("typing");

    try {
      const detail = await getRepoDetail(slug);
      if (!detail) return ctx.reply("⚠️ Repositorio no encontrado.");
      ctx.reply(buildRepoDetail(detail), {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });

      // Trust dinámico: refresca en segundo plano si falta / está viejo / versión
      // de fórmula anterior. No bloquea la respuesta; se ve fresco al reabrir.
      const eng = detail.engagement;
      const TTL_MS = Number(process.env.TRUST_TTL_MS) || 6 * 60 * 60 * 1000;
      const stale =
        !eng ||
        Number(eng.trust_score_version) < TRUST_SCORE_VERSION ||
        (eng.updated_at && Date.now() - new Date(eng.updated_at).getTime() > TTL_MS);
      if (stale) refreshRepoTrust(slug).catch(() => {});
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // /status — bot + hosting info
  telegramBot.command("status", async (ctx) => {
    await ctx.replyWithChatAction("typing");

    const mem = process.memoryUsage();
    const totalMemGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    const freeMemGb = (os.freemem() / 1024 ** 3).toFixed(1);
    const load = os.loadavg().map((n) => n.toFixed(2)).join(", ");
    const hostLabel = process.env.HOST_LABEL || "VPS (self-hosted)";

    // Probe backing services
    let pineconeStatus = "🔴 error";
    let pineconeVectors = "?";
    try {
      const stats = await getPineconeStats();
      pineconeVectors = stats.totalRecordCount ?? stats.totalVectorCount ?? "?";
      pineconeStatus = "🟢 conectado";
    } catch {
      pineconeStatus = "🔴 sin conexión";
    }

    let supabaseStatus = "🔴 error";
    try {
      const ks = await getKnowledgeStats();
      supabaseStatus = ks.error ? "🔴 error" : "🟢 conectado";
    } catch {
      supabaseStatus = "🔴 sin conexión";
    }

    const { indexName } = getPineconeConfig();

    const msg =
      "🤖 *Estado del bot*\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "🟢 *Bot:* online\n" +
      `⏱️ *Uptime proceso:* ${formatUptime(Date.now() - BOT_STARTED_AT)}\n\n` +
      "*🖥️ Hosting*\n" +
      `   📍 Entorno: ${hostLabel}\n` +
      `   🏷️ Host: \`${os.hostname()}\`\n` +
      `   ⚙️ SO: ${os.type()} ${os.release()} (${os.arch()})\n` +
      `   🟩 Node: ${process.version}\n` +
      `   ⏳ Uptime host: ${formatUptime(os.uptime() * 1000)}\n` +
      `   📈 Carga (1/5/15m): ${load}\n` +
      `   🧠 RAM host: ${freeMemGb} GB libre / ${totalMemGb} GB\n` +
      `   💾 RAM proceso: ${(mem.rss / 1024 ** 2).toFixed(0)} MB\n\n` +
      "*🔌 Servicios*\n" +
      `   🌲 Pinecone (${indexName}): ${pineconeStatus} — ${pineconeVectors} vectores\n` +
      `   🗄️ Supabase: ${supabaseStatus}`;

    ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // /data — knowledge base statistics
  telegramBot.command("data", async (ctx) => {
    await ctx.replyWithChatAction("typing");

    try {
      const [ks, pineStats] = await Promise.all([
        getKnowledgeStats(),
        getPineconeStats().catch(() => null),
      ]);

      const vectors =
        pineStats?.totalRecordCount ?? pineStats?.totalVectorCount ?? "?";

      const msg =
        "📊 *Base de conocimiento*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        `🔖 Bookmarks: *${ks.bookmarks}*\n` +
        `📦 READMEs indexados: *${ks.readmes}*\n` +
        `🧬 Vectores en Pinecone: *${vectors}*\n` +
        `🔍 Consultas totales: *${ks.queries}*` +
        (ks.error ? `\n\n⚠️ _${ks.error}_` : "");

      ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // /insights — usage analytics + content-gap signal (continuous feedback)
  telegramBot.command("insights", async (ctx) => {
    await ctx.replyWithChatAction("typing");

    try {
      const a = await getQueryAnalytics({ windowDays: 7, topN: 5 });
      const t = a.totals;
      const l = a.latency;
      const z = a.zeroResults;

      let msg =
        "📈 *Insights de uso* — últimos 7 días\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        `🔍 Consultas: *${t.all}* (24h: ${t.last24h} · 1h: ${t.lastHour})\n` +
        `✅ Tasa de éxito: *${a.successRate}%*\n` +
        `⚡ Latencia: media ${l.avg}ms · p95 ${l.p95}ms\n\n`;

      msg += "*🧩 Por interfaz*\n";
      msg += a.byInterface.length
        ? a.byInterface
            .map((x) => `   • ${escapeMd(x.interface)}: ${x.count} (${x.avgLatency}ms)`)
            .join("\n") + "\n\n"
        : "   _sin datos_\n\n";

      msg += "*🔥 Top consultas*\n";
      msg += a.topQueries.length
        ? a.topQueries
            .map((x, i) => `   ${i + 1}. ${escapeMd(x.query)} ×${x.count}`)
            .join("\n") + "\n\n"
        : "   _sin datos_\n\n";

      msg += `*⚠️ Sin resultados* — brechas de contenido (${z.total})\n`;
      msg += z.recent.length
        ? z.recent.map((x) => `   • ${escapeMd(x.query)}`).join("\n")
        : "   _ninguna — todo consulta devolvió resultados 👌_";

      const port = process.env.PORT || process.env.DASHBOARD_PORT;
      if (port) msg += `\n\n📊 _Dashboard en vivo: puerto ${port}_`;

      ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // Handle plain text as search (works in DMs and groups)
  telegramBot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // Skip commands

    // In groups, only respond to mentions or replies to bot
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    if (isGroup) {
      const botMentioned = text.includes(`@${botUsername}`) || 
                           ctx.message.reply_to_message?.from?.id === bot.botInfo?.id;
      if (!botMentioned) return;
    }

    // Remove bot mention from text
    const cleanText = text.replace(/@\w+/g, "").trim();
    if (!cleanText) return;

    await ctx.replyWithChatAction("typing");

    try {
      const results = await ragSearch(cleanText, { topK: 5, interface: "telegram", user: tgUser(ctx) });
      ctx.reply(formatTelegramResults(results), { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // Launch
  telegramBot.launch();
  console.log("[Telegram] Bot started");

  // Observability dashboard (continuous feedback) — no-op if PORT unset
  startDashboard();

  // Durable event flusher: drains the on-disk spool into Supabase and replays
  // anything left pending from a previous run — so restarts never lose events.
  startEventLog();
  console.log("[EventLog] Durable spool flusher started");

  // Graceful stop
  process.once("SIGINT", () => telegramBot.stop("SIGINT"));
  process.once("SIGTERM", () => telegramBot.stop("SIGTERM"));

  return telegramBot;
}

// CLI entry point
const args = process.argv.slice(2);
if (args[0] === "start") {
  try {
    await startTelegramBot();
  } catch (err) {
    console.error("[Telegram] Failed to start:", err.message);
    process.exit(1);
  }
}
