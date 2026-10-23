/**
 * SecurityAudit.gs — рантайм-аудит базовых аспектов безопасности.
 * Запускать из редактора Apps Script: функция securityAudit().
 * Отчёт дублируется владельцу в Telegram (если задан TELEGRAM_CHAT_ID).
 *
 * Статическая часть аудита (модель угроз, вердикты по коду, git-политика
 * для секретов) — в файле SECURITY.md репозитория.
 */

function securityAudit() {
  const L = [];
  const add = function (mark, text) { L.push(mark + ' ' + text); };

  // 1. Наличие и качество секретов (хранятся только в Script Properties)
  const props = PropertiesService.getScriptProperties().getProperties();
  const token = props[PROP.BOT_TOKEN] || '';
  const chatId = props[PROP.CHAT_ID] || '';
  const gemini = props[PROP.GEMINI_KEY] || '';
  const secret = props[PROP.WEBHOOK_SECRET] || '';
  const readToken = props[PROP.TMA_READ_TOKEN] || '';

  add(token ? '✅' : '❌', 'TELEGRAM_BOT_TOKEN: ' + (token ? 'задан' : 'ОТСУТСТВУЕТ'));
  add(chatId ? '✅' : '❌', 'TELEGRAM_CHAT_ID (whitelist): ' + (chatId ? 'задан' : 'ОТСУТСТВУЕТ — бот будет отвечать подсказкой любому'));
  add(gemini ? '✅' : '❌', 'GEMINI_API_KEY: ' + (gemini ? 'задан' : 'ОТСУТСТВУЕТ (Vision не будет работать)'));
  add(secret.length >= 32 ? '✅' : '⚠️', 'WEBHOOK_SECRET: ' + (secret ? secret.length + ' симв. (рекомендуется 32+)' : 'ОТСУТСТВУЕТ — webhook открыт для подделки'));
  add(readToken ? '✅' : '⚠️', 'TMA_READ_TOKEN: ' + (readToken ? 'чтение API защищено токеном' : 'не задан — чтение финансовых данных по URL Web App открыто (демо-режим)'));

  // 2. Валидность токена бота
  try {
    const me = tgCall_('getMe', {});
    add('✅', 'Токен бота валиден: @' + me.username);
  } catch (e) {
    add('❌', 'Токен бота невалиден: ' + e.message);
  }

  // 3. Валидность ключа Gemini (дешёвый GET списка моделей)
  try {
    const resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + gemini,
      { muteHttpExceptions: true, deadline: 15 });
    add(resp.getResponseCode() === 200 ? '✅' : '❌',
      'GEMINI_API_KEY: HTTP ' + resp.getResponseCode() + (resp.getResponseCode() === 200 ? ' — валиден' : ' — проверьте ключ'));
  } catch (e) {
    add('❌', 'GEMINI_API_KEY не удалось проверить: ' + e.message);
  }

  // 4. Webhook
  try {
    const info = tgCall_('getWebhookInfo', {});
    add(info.url ? '✅' : '⚠️', 'Webhook: ' + (info.url ? 'привязан' : 'не привязан (запустите setupWebhook)'));
    if (info.last_error_message) add('⚠️', 'Последняя ошибка доставки webhook: ' + info.last_error_message);
    if ((info.pending_update_count || 0) > 10) add('⚠️', 'Накопилось ' + info.pending_update_count + ' необработанных апдейтов');
  } catch (e) {
    add('⚠️', 'Webhook не проверен: ' + e.message);
  }

  // 5. Доступ к таблице
  try {
    const ss = ss_();
    add('✅', 'Таблица: «' + ss.getName() + '» (доступ из скрипта есть)');
  } catch (e) {
    add('❌', 'Таблица недоступна: ' + e.message);
  }

  const report = '🔐 <b>Аудит безопасности</b>\n' + nowTz_() + '\n\n' + L.join('\n');
  console.log(report.replace(/<[^>]+>/g, ''));
  if (chatId) {
    try { sendMessage_(chatId, report); } catch (e) { /* отчёт уже в логе */ }
  }
  return report;
}
