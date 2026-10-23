/**
 * Triggers.gs — cron-расписание Apps Script.
 *
 * • weeklySundayAsk   — каждое воскресенье 20:00: вопрос о недельных тратах (Workflow B)
 * • dailyMaintenance  — каждый день ~07:00: roll-forward платежей, replay, снапшот Net Worth
 * • monthlyPlanLog    — 1-го числа ~09:00: план-водопад месяца в Monthly_Cycles + сообщение
 *
 * Установка: installTriggers_() вызывается из setup(). Повторный вызов не дублирует.
 */

const TRIGGER_HANDLERS = ['weeklySundayAsk', 'dailyMaintenance', 'monthlyPlanLog'];

function installTriggers_() {
  uninstallTriggers_();

  ScriptApp.newTrigger('weeklySundayAsk')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[CONFIG.WEEKLY_ASK.weekday]) // SUNDAY
    .atHour(CONFIG.WEEKLY_ASK.hour)                          // 20:00 (близко к указанному часу)
    .create();

  ScriptApp.newTrigger('dailyMaintenance')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger('monthlyPlanLog')
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .create();

  return 'installed:' + TRIGGER_HANDLERS.join(',');
}

function uninstallTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ─────────────────────────── Handlers ───────────────────────────

/** Workflow B: воскресенье 20:00 — спросить про траты за неделю. */
function weeklySundayAsk() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (!chatId) { console.warn('TELEGRAM_CHAT_ID не задан — воскресный опрос пропущен'); return; }
  try {
    setBotState_({ mode: 'await_week', asked_at: nowTz_() });
    sendMessage_(
      chatId,
      '📅 <b>Неделя заканчивается</b>\n' +
      'Пришлите скриншот аналитики расходов из MBANK — Gemini разберёт суммы и категории.\n' +
      'Или напишите итог цифрой, например <code>4350</code> или <code>3500 kgs</code> (можно «0», если трат не было).'
    );
  } catch (e) {
    console.error('weeklySundayAsk: ' + e.message);
  }
}

/** Ежедневно: автопостановка наступивших платежей, replay долгов, снапшот Net Worth, FX. */
function dailyMaintenance() {
  try {
    const posted = DebtEngine.checkDuePayments(); // roll-forward
    DebtEngine.replayAll();
    InvestNetWorth.takeSnapshot();
    try { FXAnalytics.refreshFormulas(); } catch (fxErr) { console.warn('fx refresh: ' + fxErr.message); }
    console.log('dailyMaintenance ok; auto-posted: ' + JSON.stringify(posted));
  } catch (e) {
    console.error('dailyMaintenance: ' + e.message);
  }
}

/** 1-го числа: записать план месяца и прислать сводку владельцу. */
function monthlyPlanLog() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  try {
    const w = CashflowEngine.computeWaterfall({});
    CashflowEngine.upsertMonth(w, 'proposal');
    if (chatId) {
      sendMessage_(
        chatId,
        '🗓 <b>Новый месяц ' + w.monthKey + '</b>\n' +
        'Запишите факт дохода: /income 6200 ' + w.incomeCurrency.toLowerCase() + '\n\n' +
        CashflowEngine.renderText(w),
        monthButtons_(w.monthKey)
      );
    }
  } catch (e) {
    console.error('monthlyPlanLog: ' + e.message);
  }
}

/** Ручной тест воскресного вопроса (из редактора). */
function testWeeklyAsk() {
  weeklySundayAsk();
}
