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
   * Секрет: мастер-ключ шифрования данных at rest (base64, 32 байта).
   * Из него HKDF выводит per-user AES-GCM ключи (src/db/crypto.ts).
   * Отсутствует/битый → контуры данных fail-closed (503). Потеря = данные не расшифровать.
   */
  DATA_KEY?: string;
  /**
   * Секрет: numeric Telegram ID владельца (строка). Пусто/отсутствует →
   * авто-бутстрап владельца отключён, есть команда /id для ручной привязки.
   */
  OWNER_TELEGRAM_ID?: string;
  /** Переменная [vars]: username бота без @ (для ссылок-приглашений). */
  TELEGRAM_BOT_USERNAME?: string;
  /** Переменная [vars]: URL Mini App — на него указывает menu-button «💰 Бюджет» (setChatMenuButton). */
  MINI_APP_URL?: string;
  /** Секрет: ключ Gemini AI Studio — основной vision-провайдер (шаг 7). */
  GEMINI_API_KEY?: string;
  /** Модель Gemini для vision (по умолчанию gemini-3.5-flash-lite). */
  GEMINI_MODEL?: string;
  /** Секрет: Demo-ключ CoinGecko для автоцен крипты (T3b). Нет ключа → внешних запросов нет, цены ручные. */
  COINGECKO_API_KEY?: string;
  /** Секрет: ключ Groq — резервный vision-провайдер. */
  GROQ_API_KEY?: string;
  /** Секрет/переменная: модель Groq (умолчание — llama-4-scout). */
  GROQ_MODEL?: string;
  /** Биндинг статики Mini App (wrangler.toml [assets]); SPA-fallback из роутера. */
  ASSETS?: Fetcher;
}
