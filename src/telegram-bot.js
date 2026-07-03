import { ragSearch } from "./rag-orchestrator.js";

let bot = null;
let botUsername = "";

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
        "/filter readme <query> — Buscar solo en READMEs\n\n" +
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
