/**
 * SecurityAudit.gs — рантайм-аудит безопасности и «здоровья» продукта.
 * Запускать из редактора Apps Script: функция securityAudit().
 * Отчёт дублируется владельцу в Telegram (если задан TELEGRAM_CHAT_ID).
 *
 * Проверяет «молчаливые убийцы» продукта:
 *   • webhook указывает на старое развёртывание (URL меняется при новом деплое);
 *   • пропавшие cron-триггеры (воскресная петля, roll-forward, месячный план);
 *   • курсы GOOGLEFINANCE не рассчитались (#N/A) — расчёты идут на резервных;
 *   • Net Worth не снапшотился >2 дней (умер daily-триггер).
 *
 * Статическая часть аудита — SECURITY.md репозитория.
 */

function securityAudit() {
  const L = [];
  const add = function (mark, text) { L.push(mark + ' ' + text); };

  // 1. Наличие и качество секретов (хранятся только в Script Properties)
  const props = PropertiesService.getScriptProperties().getProperties();
  const token = props[PROP.BOT_TOKEN] || '';
  const chatId = props[PROP.CHAT_ID] || '';
  const gemini = props[PROP.GEMINI_KEY] || '';
  const groq = props[PROP.GROQ_KEY] || '';
  const secret = props[PROP.WEBHOOK_SECRET] || '';
  const readToken = props[PROP.TMA_READ_TOKEN] || '';

  add(token ? '✅' : '❌', 'TELEGRAM_BOT_TOKEN: ' + (token ? 'задан' : 'ОТСУТСТВУЕТ'));
  add(chatId ? '✅' : '❌', 'TELEGRAM_CHAT_ID (whitelist): ' + (chatId ? 'задан' : 'ОТСУТСТВУЕТ — бот будет отвечать подсказкой любому'));
  if (gemini && groq) add('✅', 'Vision: Gemini + резерв Groq (двойное покрытие)');
  else if (gemini) add('✅', 'GEMINI_API_KEY: задан (резерв Groq не настроен — опционально)');
  else if (groq) add('⚠️', 'Vision: только Groq (GEMINI_API_KEY не задан — скриншоты пойдут через резервный провайдер)');
  else add('❌', 'Vision: нет ни GEMINI_API_KEY, ни GROQ_API_KEY — разбор скриншотов работать не будет');
  add(secret.length >= 32 ? '✅' : '⚠️', 'WEBHOOK_SECRET: ' + (secret ? secret.length + ' симв. (рекомендуется 32+)' : 'ОТСУТСТВУЕТ — webhook открыт для подделки'));
  add(readToken ? '✅' : '⚠️', 'TMA_READ_TOKEN: ' + (readToken ? 'чтение API защищено токеном' : 'не задан — чтение финансовых данных по URL Web App открыто (запустите setup(), он создаст токен)'));

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

  // 4. Webhook: привязка, ошибки доставки, и главное — тот ли это URL развёртывания
  try {
    const info = tgCall_('getWebhookInfo', {});
    add(info.url ? '✅' : '⚠️', 'Webhook: ' + (info.url ? 'привязан' : 'не привязан (запустите setupWebhook)'));
    if (info.last_error_message) add('⚠️', 'Последняя ошибка доставки webhook: ' + info.last_error_message);
    if ((info.pending_update_count || 0) > 10) add('⚠️', 'Накопилось ' + info.pending_update_count + ' необработанных апдейтов');
    const current = String(ScriptApp.getService().getUrl() || '').split('?')[0];
    const hooked = String(info.url || '').split('?')[0];
    if (current && hooked && current !== hooked) {
      add('❌', 'Webhook смотрит на ДРУГОЕ развёртывание (' + hooked + ' ≠ ' + current +
        '). Бот мог молча замолчать — перепустите setupWebhook()');
    }
  } catch (e) {
    add('⚠️', 'Webhook не проверен: ' + e.message);
  }

  // 5. Cron-триггеры: воскресный опрос, пн-надж, ежедневный roll-forward, месячный план
  try {
    const need = ['weeklySundayAsk', 'mondayNudge', 'dailyMaintenance', 'monthlyPlanLog'];
    const installed = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    need.forEach(function (h) {
      add(installed.indexOf(h) >= 0 ? '✅' : '❌',
        'Триггер ' + h + (installed.indexOf(h) >= 0 ? ' — установлен' : ' — ОТСУТСТВУЕТ (перепустите setup())'));
    });
  } catch (e) {
    add('⚠️', 'Триггеры не проверены: ' + e.message);
  }

  // 6. Свежесть данных: последний снапшот Net Worth
  try {
    const hist = InvestNetWorth.history(2);
    if (!hist.length) {
      add('⚠️', 'Net Worth: снапшотов нет ни одного — выполните /sync (daily-триггер ещё не отрабатывал)');
    } else {
      const last = hist[hist.length - 1].date;
      const age = Math.round(
        (new Date(fmtISO_(new Date()) + 'T00:00:00') - new Date(last + 'T00:00:00')) / 86400000);
      add(age <= 2 ? '✅' : '❌', 'Net Worth: снапшот ' + last + ' (' + age + ' дн. назад)' +
        (age > 2 ? ' — похоже, daily-триггер не работает' : ''));
    }
  } catch (e) {
    add('⚠️', 'Net Worth история не проверена: ' + e.message);
  }

  // 7. Курсы: живой GOOGLEFINANCE или резервные значения
  try {
    add(getFx_().FALLBACK_USED ? '⚠️' : '✅',
      'Курсы: ' + (getFx_().FALLBACK_USED
        ? 'GOOGLEFINANCE недоступен (B2:B4 = #N/A/пусто) — расчёты на резервных значениях из Config.gs'
        : 'GOOGLEFINANCE рассчитан, конвертации живые'));
  } catch (e) {
    add('⚠️', 'Курсы не проверены: ' + e.message);
  }

  // 8. Доступ к таблице
  try {
    const ss = ss_();
    add('✅', 'Таблица: «' + ss.getName() + '» (доступ из скрипта есть)');
  } catch (e) {
    add('❌', 'Таблица недоступна: ' + e.message);
  }

  const report = '🔐 <b>Аудит безопасности и здоровья</b>\n' + nowTz_() + '\n\n' + L.join('\n');
  console.log(report.replace(/<[^>]+>/g, ''));
  if (chatId) {
    try { sendMessage_(chatId, report); } catch (e) { /* отчёт уже в логе */ }
  }
  return report;
}
