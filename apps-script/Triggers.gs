/**
 * Triggers.gs — cron-расписание Apps Script.
 *
 * • weeklySundayAsk   — каждое воскресенье 20:00: вопрос о недельных тратах (Workflow B)
 * • mondayNudge       — понедельник 09:00: мягкое напоминание, если опрос без ответа (P0)
 * • dailyMaintenance  — каждый день ~07:00: roll-forward платежей, replay, снапшот Net Worth,
 *                       FX-алерты (P0), напоминания о списаниях за 2 дня (P0),
 *                       digest «факт vs план» в последний день месяца (P1)
 * • monthlyPlanLog    — 1-го числа ~09:00: план месяца + сверка ипотек с банком (P1)
 *
 * Установка: installTriggers_() вызывается из setup(). Повторный вызов не дублирует.
 */

const TRIGGER_HANDLERS = ['weeklySundayAsk', 'mondayNudge', 'dailyMaintenance', 'monthlyPlanLog'];

function installTriggers_() {
  uninstallTriggers_();

  ScriptApp.newTrigger('weeklySundayAsk')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[CONFIG.WEEKLY_ASK.weekday]) // SUNDAY
    .atHour(CONFIG.WEEKLY_ASK.hour)                          // 20:00 (близко к указанному часу)
    .create();

  ScriptApp.newTrigger('mondayNudge')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
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
    MetricsEngine.logOnce('weekly_ask:' + weekKey_(new Date()), 'sent');
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

/** P0: понедельник 09:00 — опрос воскресенья остался без ответа? */
function mondayNudge() {
  try {
    const state = getBotState_();
    if (state.mode !== 'await_week') return;
    const chatId = getProp_(PROP.CHAT_ID, '');
    if (!chatId) return;
    sendMessage_(
      chatId,
      '👋 Небольшое напоминание: итог прошлой недели ещё не записан.\n' +
      'Пришлите скриншот MBANK или сумму цифрой — займёт 15 секунд.'
    );
  } catch (e) {
    console.error('mondayNudge: ' + e.message);
  }
}

/** Ежедневно: roll-forward, снапшоты, FX-алерты, напоминания о списаниях, аномалии, digest. */
function dailyMaintenance() {
  try {
    const posted = DebtEngine.checkDuePayments(); // roll-forward
    DebtEngine.replayAll();
    InvestNetWorth.takeSnapshot();
    try { FXAnalytics.refreshFormulas(); } catch (fxErr) { console.warn('fx refresh: ' + fxErr.message); }
    try { FXAnalytics.checkAlerts(); } catch (alertErr) { console.warn('fx alerts: ' + alertErr.message); }
    try { checkBillReminders_(); } catch (billErr) { console.warn('bills: ' + billErr.message); }
    try { AnomalyEngine.runAndNotify(); } catch (anomErr) { console.warn('anomalies: ' + anomErr.message); }
    try { maybeSendMonthDigest_(); } catch (dErr) { console.warn('digest: ' + dErr.message); }
    logOps_('INFO', 'daily', 'maintenance ok; auto-posted: ' + (posted.length ? posted.join(',') : 'none'));
    console.log('dailyMaintenance ok; auto-posted: ' + JSON.stringify(posted));
  } catch (e) {
    logOps_('ERROR', 'daily', e.message);
    console.error('dailyMaintenance: ' + e.message);
  }
}

/**
 * P0: напоминания о списаниях за 2 дня.
 * Месячные позиции — из Commitments_Registry (due_day), ипотеки —
 * Сбер по due_day из Config, Т-Банк каждые 14 дней от Epoch.
 */
function checkBillReminders_() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (!chatId) return;
  const fx = getFx_();
  const now = new Date();
  const items = [];

  const daysUntil = function (d) {
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d - a) / 86400000);
  };
  const dueThisCycle = function (dueDay) {
    let d = new Date(now.getFullYear(), now.getMonth(), dueDay);
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      d = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
    }
    return d;
  };

  // Реестр обязательств (кроме ипотек — они ниже с точными датами)
  readRange_(SHEETS.COMMITMENTS, 2).forEach(function (r) {
    const active = r[6] === true || String(r[6]).toUpperCase() === 'TRUE';
    const dueDay = Number(r[5]);
    if (!active || !dueDay || String(r[0]) === 'Mortgages') return;
    if (daysUntil(dueThisCycle(dueDay)) === 2) {
      const cur = String(r[3] || 'USD').toUpperCase();
      const rub = convert_(Number(r[2]) || 0, cur, 'RUB', fx);
      items.push('«' + r[1] + '» — ' + fmtMoney_(Number(r[2]) || 0, cur) +
        ' (≈' + fmtMoney_(rub, 'RUB') + '), списание ' + fmtISO_(dueThisCycle(dueDay)));
    }
  });

  // Ипотеки
  DebtEngine.getDebts().forEach(function (debt) {
    if (debt.type === 'monthly') {
      const dueDay = DebtEngine.cfgById_(debt.id) ? DebtEngine.cfgById_(debt.id).due_day : 25;
      if (daysUntil(dueThisCycle(dueDay)) === 2) {
        items.push(debt.name + ' — ' + fmtMoney_(debt.payment, 'RUB') + ', списание ' + fmtISO_(dueThisCycle(dueDay)));
      }
    } else {
      // biweekly: следующий платёж через кратное 14 число дней от Epoch
      const elapsed = Math.ceil((now - debt.epoch) / 86400000 / 14);
      const next = new Date(debt.epoch.getTime() + elapsed * 14 * 86400000);
      if (daysUntil(next) === 2) {
        items.push(debt.name + ' — ' + fmtMoney_(debt.payment, 'RUB') + ' (раз в 2 недели), списание ' + fmtISO_(next));
      }
    }
  });

  if (items.length) {
    sendMessage_(
      chatId,
      '🔔 <b>Списания через 2 дня</b>\n• ' + items.join('\n• ') +
      '\n\nПроверьте остаток на счёте; при необходимости конвертируйте: /fx'
    );
  }
  return items;
}

/** P1: digest в последний день месяца (завтра 1-е число). */
function maybeSendMonthDigest_() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return false;
  const chatId = getProp_(PROP.CHAT_ID, '');
  const text = MetricsEngine.buildMonthDigest();
  console.log(text.replace(/<[^>]+>/g, ''));
  if (chatId) sendMessage_(chatId, text);
  return true;
}

/** 1-го числа: план месяца + сверка ипотек с банком (P1) + автобэкап. */
function monthlyPlanLog() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  try {
    try { backupNow(); } catch (bErr) { console.warn('backup: ' + bErr.message); }
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
      sendReconciliationPrompt_(fmtMonthKey_(new Date()));
    }
  } catch (e) {
    console.error('monthlyPlanLog: ' + e.message);
  }
}

/** P1: сверка балансов ипотек с приложением банка. */
function sendReconciliationPrompt_(monthKey) {
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (!chatId) return;
  const debts = DebtEngine.getDebts();
  const lines = debts.map(function (d) {
    return '• ' + d.name + ': <b>' + fmtMoney_(d.balance, 'RUB') + '</b>';
  });
  sendMessage_(
    chatId,
    '🏦 <b>Сверка с банком</b> (' + monthKey + ')\n' +
    'Балансы в движке:\n' + lines.join('\n') + '\n\n' +
    'Откройте приложения Сбербанк/Т-Банк и сверьте остатки ипотек.',
    [
      { text: '✅ Всё совпадает', callback_data: 'recon_ok:' + monthKey },
      { text: '📸 Пришлю скрины', callback_data: 'recon_how' },
    ]
  );
}

/** Ручной тест воскресного вопроса (из редактора). */
function testWeeklyAsk() {
  weeklySundayAsk();
}
