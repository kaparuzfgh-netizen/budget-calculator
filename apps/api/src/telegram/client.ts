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

export interface InlineButton {
  text: string;
  callback_data?: string; // ≤64 байт
  url?: string;
}

export interface ReplyMarkup {
  inline_keyboard?: InlineButton[][];
  keyboard?: string[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
}

export interface SendMessageOpts {
  parseMode?: 'HTML' | undefined;
  disableNotification?: boolean;
  replyMarkup?: ReplyMarkup;
}

export interface TelegramClient {
  sendMessage(chatId: number | string, text: string, opts?: SendMessageOpts): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

interface TgApiResult {
  ok: boolean;
  description?: string;
}

export function createTelegramClient(opts: { token: string; fetchImpl?: typeof fetch }): TelegramClient {
  const f = opts.fetchImpl ?? fetch;
  const call = async (method: string, body: unknown) => {
    // URL с токеном существует только внутри этого вызова.
    const res = await f(`https://api.telegram.org/bot${opts.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let description = res.statusText;
    try {
      const j = (await res.json()) as TgApiResult;
      if (typeof j.description === 'string') description = j.description;
    } catch {
      /* тело не JSON — оставляем statusText */
    }
    if (!res.ok) throw new TelegramError(res.status, description);
  };

  return {
    async sendMessage(chatId, text, o) {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: o?.parseMode ?? 'HTML',
        disable_notification: o?.disableNotification,
        reply_markup: o?.replyMarkup,
      });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
    },
  };
}
