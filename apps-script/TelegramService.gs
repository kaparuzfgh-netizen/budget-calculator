/**
 * TelegramService.gs — обёртка Telegram Bot API.
 * Сообщения (HTML), inline-клавиатуры, callback-ответы, скачивание файлов.
 */

const TG_API = 'https://api.telegram.org';

function tgToken_() {
  const t = getProp_(PROP.BOT_TOKEN, '');
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  return t;
}

function tgCall_(method, payload) {
  const resp = UrlFetchApp.fetch(TG_API + '/bot' + tgToken_() + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
    followRedirects: true,
    deadline: CONFIG.HTTP_TIMEOUT_MS / 1000,
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('Telegram ' + method + ': невалидный ответ (' + code + '): ' + body.slice(0, 200));
  }
  if (!json.ok) throw new Error('Telegram ' + method + ': ' + (json.description || code));
  return json.result;
}

function sendMessage_(chatId, html, opts) {
  opts = opts || {};
  const payload = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (opts.buttons && opts.buttons.length) payload.reply_markup = { inline_keyboard: [opts.buttons] };
  else if (opts.menu) payload.reply_markup = { keyboard: opts.menu, resize_keyboard: true, is_persistent: true };
  return tgCall_('sendMessage', payload);
}

function answerCallback_(callbackQueryId, text) {
  try {
    tgCall_('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
  } catch (e) {
    console.warn('answerCallback: ' + e.message);
  }
}

/** Скачивает файл из Telegram CDN → { base64, mime } для Gemini. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // лимит против DoS и сжигания квоты Gemini

function downloadTelegramFile_(fileId) {
  const info = tgCall_('getFile', { file_id: fileId });
  if (!info.file_path) throw new Error('Telegram не вернул file_path');
  if (info.file_size && info.file_size > MAX_IMAGE_BYTES) {
    throw new Error('Файл слишком большой (>8 МБ). Пришлите скриншот поменьше.');
  }
  const url = TG_API + '/file/bot' + tgToken_() + '/' + info.file_path;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, deadline: CONFIG.HTTP_TIMEOUT_MS / 1000 });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Не удалось скачать файл из Telegram (HTTP ' + resp.getResponseCode() + ')');
  }
  const blob = resp.getBlob();
  const mime = blob.getContentType() || 'image/jpeg';
  if (!/^image\//.test(mime)) {
    throw new Error('Это не изображение (' + mime + '). Пришлите, пожалуйста, скриншот картинкой.');
  }
  const bytes = blob.getBytes();
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Изображение слишком большое (>8 МБ).');
  }
  return { base64: Utilities.base64Encode(bytes), mime: mime };
}

function escHtml_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** URL таблицы — для кнопки Edit Commitments и ссылок. */
function sheetUrl_() {
  return ss_().getUrl();
}

/** Whitelist: бот отвечает только владельцу (или подсказывает chat_id, если он не задан). */
function authorizeChat_(chatId) {
  const owner = getProp_(PROP.CHAT_ID, '');
  if (!owner) {
    sendMessage_(
      chatId,
      '🔐 Chat ID этого чата: <code>' + chatId + '</code>\n\n' +
        'Добавьте его в Script Properties как <b>TELEGRAM_CHAT_ID</b> и повторите команду.'
    );
    return false;
  }
  return String(chatId) === String(owner);
}
