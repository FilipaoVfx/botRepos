import os from "os";
import { ragSearch, getKnowledgeStats } from "./rag-orchestrator.js";
import { getPineconeStats, getPineconeConfig } from "./rag-pinecone.js";

let bot = null;
let botUsername = "";
const BOT_STARTED_AT = Date.now();

// List of commands shown in the Telegram "/" menu (registered via setMyCommands)
const BOT_COMMANDS = [
  { command: "search", description: "Buscar en bookmarks y READMEs" },
  { command: "filter", description: "Filtrar: /filter <bookmark|readme> <query>" },
  { command: "status", description: "Estado del bot y del hosting" },
  { command: "data", description: "Estadísticas de la base de conocimiento" },
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
        "/status — Estado del bot y del hosting\n" +
        "/data — Estadísticas de la base de conocimiento\n" +
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
        "/status — Estado del bot y del hosting\n" +
        "/data — Estadísticas de la base de conocimiento\n\n" +
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
      const results = await ragSearch(query, { topK: 3, interface: "telegram" });
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
      const results = await ragSearch(query, { topK: 5, sourceType, interface: "telegram" });
      ctx.reply(formatTelegramResults(results), { parse_mode: "Markdown" });
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
      const results = await ragSearch(cleanText, { topK: 5, interface: "telegram" });
      ctx.reply(formatTelegramResults(results), { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // Launch
  telegramBot.launch();
  console.log("[Telegram] Bot started");

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
