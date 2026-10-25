/**
 * webhook-utils.mjs — чистые хелперы scripts/telegram-webhook.mjs.
 * Никаких node:* импортов — файл тестируется в workerd-сюите.
 */

/** Маскирует URL для печати: origin + pathname, query/фрагмент отрезаются. */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '(невалидный URL)';
  }
}

/** Удаляет секреты из произвольного текста (ошибок API и т.п.). */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && typeof s === 'string') out = out.split(s).join('***');
  }
  return out;
}

/** Валидация URL вебхука: только https://. */
export function parseWebhookUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Невалидный URL вебхука: ${maskUrl(url)}`);
  }
  if (u.protocol !== 'https:') {
    throw new Error('URL вебхука должен начинаться с https://');
  }
  return u.toString();
}

/** Тело для setWebhook (секрет не логируем, не сохраняем). */
export function buildSetWebhookPayload({ url, secretToken }) {
  const payload = {
    url: parseWebhookUrl(url),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
  if (secretToken) payload.secret_token = secretToken;
  return payload;
}
