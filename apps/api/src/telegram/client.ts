/**
 * client.ts — минимальный клиент Telegram Bot API.
 * Токен никогда не попадает в сообщения ошибок/логи: URL с токеном строится
 * локально и не покидает fetch; в ошибку кладём только HTTP-статус и
 * текстовое описание от Telegram.
 */

export class TelegramError extends Error {
  readonly status: number;
  readonly description: string;

  constructor(status: number, description: string) {
    super(`Telegram API ${status}: ${description}`);
    this.name = 'TelegramError';
    this.status = status;
    this.description = description;
  }
}

/** Экранирование пользовательского текста для parse_mode=HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Убрать теги для повторной отправки без parse_mode (видимый текст сохраняется). */
export function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/**
 * Короткое безопасное описание ошибки для логов: статус + описание Telegram
 * без URL/токенов/текста сообщения, ≤120 символов (S-логирование).
 */
export function sanitizeTelegramError(e: unknown): string {
  if (!(e instanceof TelegramError)) return e instanceof Error ? e.name : 'unknown';
  const desc = e.description
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{10,}/g, 'bot***')
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 120);
  return `TelegramError ${e.status}: ${desc}`;
}

export interface InlineButton {
  text: string;
  callback_data?: string; // ≤64 байт
  url?: string;
  /** Открывает Mini App (WebApp) — у такой кнопки callback_data нет. */
  web_app?: { url: string };
}

export interface ReplyMarkup {
  inline_keyboard?: InlineButton[][];
  keyboard?: string[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  /** Явно скрыть ранее показанную reply-клавиатуру (миграция kb_removed). */
  remove_keyboard?: boolean;
}

export interface SendMessageOpts {
  parseMode?: 'HTML' | undefined;
  disableNotification?: boolean;
  replyMarkup?: ReplyMarkup;
}

export interface TelegramClient {
  sendMessage(chatId: number | string, text: string, opts?: SendMessageOpts): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Документ (multipart, Workers-compatible FormData+Blob). */
  sendDocument(chatId: number | string, filename: string, content: string | Uint8Array, mime?: string): Promise<void>;
  /** Метаданные файла (getFile) — нужен vision-флоу; в тест-моках может отсутствовать. */
  getFile?(fileId: string): Promise<{ file_path: string; file_size?: number }>;
  /** Скачивание файла с серверов Telegram (https://api.telegram.org/file/bot…). */
  downloadFileBytes?(filePath: string): Promise<Uint8Array>;
  /** sendChatAction (typing и т.п.) — best-effort индикатор работы. */
  sendChatAction?(chatId: number | string, action: string): Promise<void>;
}

interface TgApiResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/** P2-4: зависший Telegram API не держит запрос до лимита рантайма. */
const FETCH_TIMEOUT_MS = 8000;

export function createTelegramClient(opts: { token: string; fetchImpl?: typeof fetch }): TelegramClient {
  const f = opts.fetchImpl ?? fetch;
  /** Вызов Bot API → result. Токен в URL не покидает функцию и не попадает в ошибки. */
  const call = async (method: string, body: unknown): Promise<unknown> => {
    // URL с токеном существует только внутри этого вызова.
    const res = await f(`https://api.telegram.org/bot${opts.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // abort → обычная ошибка, обрабатываемая вызывающими как сбой отправки
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let description = res.statusText;
    let result: unknown;
    try {
      const j = (await res.json()) as TgApiResult;
      if (typeof j.description === 'string') description = j.description;
      result = j.result;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    if (!res.ok) throw new TelegramError(res.status, description);
    return result;
  };

  return {
    async sendDocument(chatId, filename, content, mime = 'application/json') {
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append('document', new Blob([content], { type: mime }), filename);
      const res = await f(`https://api.telegram.org/bot${opts.token}/sendDocument`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const json = (await res.json()) as TgApiResult;
      if (!json.ok) throw new TelegramError(res.status, json.description ?? 'sendDocument failed');
    },
    async sendMessage(chatId, text, o) {
      const body = {
        chat_id: chatId,
        text,
        parse_mode: o?.parseMode ?? 'HTML',
        disable_notification: o?.disableNotification,
        reply_markup: o?.replyMarkup,
      };
      try {
        await call('sendMessage', body);
      } catch (e) {
        // Telegram 400 "can't parse entities" — ретрай БЕЗ parse_mode:
        // пользователь всё равно получает ответ, текст плоский.
        if (
          e instanceof TelegramError &&
          e.status === 400 &&
          /parse entities/i.test(e.description) &&
          body.parse_mode
        ) {
          await call('sendMessage', { ...body, text: stripTags(text), parse_mode: undefined });
          return;
        }
        throw e;
      }
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
    },
    async getFile(fileId) {
      const result = (await call('getFile', { file_id: fileId })) as
        | { file_path?: string; file_size?: number }
        | undefined;
      if (!result?.file_path) throw new TelegramError(0, 'getFile: нет file_path в ответе');
      return {
        file_path: result.file_path,
        ...(result.file_size !== undefined ? { file_size: result.file_size } : {}),
      };
    },
    async downloadFileBytes(filePath) {
      // file_path и токен — только внутри этого URL; в ошибку уходит лишь статус.
      const res = await f(`https://api.telegram.org/file/bot${opts.token}/${filePath}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new TelegramError(res.status, 'file download failed');
      return new Uint8Array(await res.arrayBuffer());
    },
    async sendChatAction(chatId, action) {
      await call('sendChatAction', { chat_id: chatId, action });
    },
  };
}
