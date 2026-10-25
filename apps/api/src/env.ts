/** Биндинги и секреты воркера (wrangler.toml + `wrangler secret put`). */
export interface Env {
  /** База D1 «budget-companion». */
  DB: D1Database;
  /** Секрет: токен бота от @BotFather. */
  TELEGRAM_BOT_TOKEN: string;
  /** Секрет: значение заголовка X-Telegram-Bot-Api-Secret-Token для webhook. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Секрет: ключ подписи JWT сессий Mini App (HS256). */
  JWT_SECRET: string;
}
