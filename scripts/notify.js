import dotenv from "dotenv";
dotenv.config({ quiet: true });

// Envía una alerta de operación por Telegram al chat de OPS_CHAT_ID usando el
// token del propio bot. Va directo a la Bot API (sin Telegraf) para no competir
// con el long polling del proceso del bot.
//
//   node scripts/notify.js "texto de la alerta"
//
// Sin OPS_CHAT_ID solo escribe en stdout (queda en el journal) y sale 0: una
// alerta que no se puede enviar nunca debe tumbar la unidad que la dispara.

export async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.OPS_CHAT_ID;
  const host = process.env.HOST_LABEL || "botRepos";
  const body = `🤖 botRepos · ${host}\n${text}`;

  if (!token || !chatId) {
    console.log(`[notify] (sin OPS_CHAT_ID/TELEGRAM_BOT_TOKEN) ${body}`);
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) {
      console.error(`[notify] Telegram rechazó el mensaje: ${j.description || res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] Error enviando alerta: ${err.message}`);
    return false;
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    console.error('Uso: node scripts/notify.js "texto"');
    process.exit(1);
  }
  await notify(text);
}
