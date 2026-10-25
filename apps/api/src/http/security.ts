/**
 * security.ts — проверка заголовка webhook (аудит S4).
 * Fail-closed: секрет не задан → отказ; сравнение — константное по времени:
 * обе стороны хэшируются SHA-256 (Web Crypto есть в workerd), сравнение
 * дайджестов побайтовое без раннего выхода. Хэширование также уравнивает длины.
 */

async function sha256Hex(s: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(s);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Константное по времени сравнение строк (через дайджесты). */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = da.length === db.length ? 0 : 1;
  for (let i = 0; i < da.length && i < db.length; i++) {
    diff |= da[i]! ^ db[i]!;
  }
  return diff === 0;
}

export type WebhookAuth = 'ok' | 'unset' | 'mismatch';

/**
 * Сверка заголовка X-Telegram-Bot-Api-Secret-Token.
 * 'unset' — секрет не настроен (fail-closed), 'mismatch' — неверный/нет заголовка.
 */
export async function verifyWebhookSecret(header: string | null, secret: string | undefined): Promise<WebhookAuth> {
  if (!secret) return 'unset';
  if (!header) return 'mismatch';
  return (await timingSafeEqualStr(header, secret)) ? 'ok' : 'mismatch';
}
