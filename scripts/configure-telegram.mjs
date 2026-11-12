import { commands } from "../lib/telegram-commands.mjs";

const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL } = process.env;
const webhookBase = process.argv[2];
if (![TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL, webhookBase].every(Boolean)) {
  throw new Error("Provide environment variables and the Neon Function HTTPS base URL");
}
for (const url of [APP_URL, webhookBase]) if (new URL(url).protocol !== "https:") throw new Error("HTTPS required");
async function call(method, body = {}) {
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method} HTTP ${response.status}`);
  return data.result;
}
const bot = await call("getMe");
await call("setWebhook", { url: new URL("/telegram", webhookBase).href, secret_token: TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"], max_connections: 8 });
await call("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть Mini App", web_app: { url: APP_URL } } });
await call("setMyCommands", { commands });
const [info, registered, menu] = await Promise.all([call("getWebhookInfo"), call("getMyCommands"), call("getChatMenuButton")]);
if (info.url !== new URL("/telegram", webhookBase).href || menu.web_app?.url !== new URL(APP_URL).href
  || registered.map(c => c.command).join(",") !== commands.map(c => c.command).join(",")) {
  throw new Error("Telegram configuration verification failed");
}
console.log(JSON.stringify({ bot: bot.username, webhook: info.url, pending: info.pending_update_count,
  commands: registered.map(c => c.command), miniApp: menu.web_app.url }));
