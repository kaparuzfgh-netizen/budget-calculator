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
  /**
   * Секрет: numeric Telegram ID владельца (строка). Пусто/отсутствует →
   * авто-бутстрап владельца отключён, есть команда /id для ручной привязки.
   */
  OWNER_TELEGRAM_ID?: string;
  /** Переменная [vars]: username бота без @ (для ссылок-приглашений). */
  TELEGRAM_BOT_USERNAME?: string;
  /** Переменная [vars]: URL Mini App — на него указывает menu-button «� Бюджет» (setChatMenuButton). */
  MINI_APP_URL?: string;
  /** Секрет: ключ Gemini AI Studio — основной vision-провайдер (шаг 7). */
  GEMINI_API_KEY?: string;
  /** Секрет: ключ Groq — резервный vision-провайдер. */
  GROQ_API_KEY?: string;
  /** Секрет/переменная: модель Groq (умолчание — llama-4-scout). */
  GROQ_MODEL?: string;
  /** Биндинг статики Mini App (wrangler.toml [assets]); SPA-fallback из роутера. */
  ASSETS?: Fetcher;
}
