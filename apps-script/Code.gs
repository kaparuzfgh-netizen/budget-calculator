/**
 * Code.gs — точка входа Web App: роутер Telegram Webhook + команды бота.
 *
 * doPost(e):  1) апдейты Telegram (update_id в теле)  2) POST Mini App (TmaApi)
 * doGet(e):   REST Mini App (TmaApi) — см. TmaApi.gs
 */

function doPost(e) {
  try {
    let body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (parseErr) { /* ignore */ }

    if (body.update_id !== undefined) {
      const expected = getProp_(PROP.WEBHOOK_SECRET, '');
      const got = (e && e.parameter && e.parameter.secret) || '';
      if (expected && got !== expected) throw new Error('Неверный webhook secret');
      handleUpdate_(body);
      return ContentService.createTextOutput('ok');
    }
    return tmaHandlePost_(e, body);
  } catch (err) {
    console.error('doPost: ' + err.message + '\n' + (err.stack || ''));
    notifyOwnerError_(err);
    return ContentService.createTextOutput('ok'); // Telegram требует 200, иначе ретраи
  }
}

/** Ошибка в работе — одно сообщение владельцу (не чаще раза в 10 минут) + Ops_Log. */
function notifyOwnerError_(err) {
  try {
    logOps_('ERROR', 'runtime', String(err.message || err).slice(0, 300));
    const cache = CacheService.getScriptCache();
    if (cache.get('lastErrNotify')) return;
    cache.put('lastErrNotify', '1', 600);
    const chatId = getProp_(PROP.CHAT_ID, '');
    if (chatId) {
      sendMessage_(chatId, '⚠️ Ошибка: <code>' + escHtml_(err.message).slice(0, 300) + '</code>\nПодробности в логах Apps Script и листе Ops_Log.');
    }
  } catch (e) { /* best effort */ }
}

// ─────────────────────────── Маршрутизация апдейтов ───────────────────────────

function handleUpdate_(upd) {
  if (upd.callback_query) { handleCallback_(upd.callback_query); return; }
  const msg = upd.message || upd.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  if (!authorizeChat_(chatId)) return;

  if (msg.photo && msg.photo.length) { handlePhoto_(chatId, msg.photo[msg.photo.length - 1].file_id, ''); return; }
  if (msg.document && msg.document.mime_type && msg.document.mime_type.indexOf('image/') === 0) {
    handlePhoto_(chatId, msg.document.file_id, msg.document.mime_type);
    return;
  }
  const text = String(msg.text || '').trim();
  if (!text) return;

  if (text.charAt(0) === '/') { routeCommand_(chatId, text); return; }
  handleFreeText_(chatId, text);
}

// ─────────────────────────── Команды ───────────────────────────

const CMD_ALIAS = {
  'доход': 'income', 'бонус': 'income', 'трата': 'spent', 'неделя': 'week',
  'план': 'plan', 'статус': 'status', 'досрочное': 'prepay', 'чдп': 'prepay',
  'ипотека': 'mortgage', 'инвестиции': 'invest', 'портфель': 'invest',
  'кэш': 'cash', 'cash': 'cash', 'синк': 'sync', 'приложение': 'app',
  'валюта': 'fx', 'курс': 'fx', 'курсы': 'fx', 'валютаанализ': 'fx',
  'баланс': 'balance', 'остаток': 'balance', 'алиас': 'alias', 'категория': 'alias',
  'гайд': 'guide', 'метрики': 'metrics', 'аномалии': 'anomalies', 'аномалия': 'anomalies',
};

function routeCommand_(chatId, text) {
  const m = text.match(/^\/([A-Za-zА-Яа-яЁё0-9_]+)(@\w+)?\s*([\s\S]*)$/);
  if (!m) { sendHelp_(chatId); return; }
  let cmd = m[1].toLowerCase();
  if (CMD_ALIAS[cmd]) cmd = CMD_ALIAS[cmd];
  const args = (m[3] || '').trim();

  try {
    switch (cmd) {
      case 'start': sendStart_(chatId); break;
      case 'help': sendHelp_(chatId); break;
      case 'plan': cmdPlan_(chatId, args); break;
      case 'income': cmdIncome_(chatId, args); break;
      case 'spent': cmdSpent_(chatId, args); break;
      case 'week': cmdWeek_(chatId); break;
      case 'prepay': cmdPrepay_(chatId, args); break;
      case 'mortgage': cmdMortgage_(chatId, args); break;
      case 'invest': cmdInvest_(chatId); break;
      case 'fx': cmdFx_(chatId); break;
      case 'balance': cmdBalance_(chatId, args); break;
      case 'alias': cmdAlias_(chatId, args); break;
      case 'guide': cmdGuide_(chatId); break;
      case 'metrics': cmdMetrics_(chatId); break;
      case 'anomalies': cmdAnomalies_(chatId); break;
      case 'cash': cmdCash_(chatId, args); break;
      case 'status': cmdStatus_(chatId); break;
      case 'sync': cmdSync_(chatId); break;
      case 'app': cmdApp_(chatId); break;
      default: sendHelp_(chatId, 'Неизвестная команда /' + escHtml_(cmd));
    }
  } catch (err) {
    console.error('cmd ' + cmd + ': ' + err.message);
    sendMessage_(chatId, '❌ ' + escHtml_(err.message));
  }
}

function sendStart_(chatId) {
  sendMessage_(
    chatId,
    '👋 <b>Personal Finance Companion</b>\n' +
    'База — Google Sheets, курсы и цены — GOOGLEFINANCE, скриншоты чеков разбирает Gemini.\n\n' +
    '/plan — водопад месяца: доход → обязательства → профицит → каскад\n' +
    '/income 6200 eur — записать доход и применить каскад\n' +
    '/spent 3200 — быстрая трата · или просто пришлите скриншот MBANK\n' +
    '/week — недельный бюджет и допустимый дневной расход\n' +
    '/prepay sber 50000 — ЧДП: пересчёт платежа с сохранением срока\n' +
    '/invest · /status · /cash · /sync · /app — остальное в /help'
  );
}

function sendHelp_(chatId, prefix) {
  sendMessage_(
    chatId,
    (prefix ? prefix + '\n\n' : '') +
    '<b>Команды</b>\n' +
    '/plan [сумма] [валюта] — водопад месяца (без аргументов — по базовому доходу)\n' +
    '/income 6200 eur [заметка] — доход месяца: каскад дельты бонуса 50/50 + кнопка Apply\n' +
    '/spent 3200 [₽/kgs/$] [заметка] — трата в недельный учёт\n' +
    'фото-скриншот MBANK — расходы; скриншот ипотеки — сверка остатка с банком\n' +
    '/week — бюджет недели/месяца, burn rate, дневной лимит\n' +
    '/prepay sber|tbank 50000 — частичное досрочное погашение\n' +
    '/balance sber 1234567 — сверка остатка ипотеки вручную\n' +
    '/mortgage sber|tbank [сумма] — отметить плановый платёж вручную\n' +
    '/invest — портфель и дрейф от целей 58/23/19\n' +
    '/fx — валюты: перцентили, RSI, прогноз 7/30д и когда выгодно менять EUR→₽/сом/$\n' +
    '/cash 12000 kgs — остаток кэша в валюте (usd/eur/rub/kgs)\n' +
    '/alias "кафе" Питание — исправить категорию Vision на будущее\n' +
    '/status — Net Worth (кэш + вклады + портфель − долг)\n' +
    '/metrics — продуктовые метрики (ответы недели, savings rate, vision)\n' +
    '/anomalies — проверка невозможных цифр (остатки, курсы, суммы, Net Worth)\n' +
    '/sync — roll-forward долгов + снапшот Net Worth\n' +
    '/guide — гид установки: что готово и следующий шаг\n' +
    '/app — открыть Mini App (дашборд со слайдерами)'
  );
}

/** /plan — просмотр водопада (доход по умолчанию = базе, либо сумма из аргументов). */
function cmdPlan_(chatId, args) {
  const income = parseIncomeArgs_(args);
  const w = CashflowEngine.computeWaterfall(income);
  sendMessage_(chatId, CashflowEngine.renderText(w), monthButtons_(w.monthKey));
}

/** /income — Workflow A: ingest → waterfall → предложение с кнопками. */
function cmdIncome_(chatId, args) {
  const income = parseIncomeArgs_(args);
  if (!income.incomeAmount) {
    throw new Error('Формат: /income 6200 eur (сумма и валюта обязательны)');
  }
  const w = CashflowEngine.computeWaterfall(income);
  CashflowEngine.upsertMonth(w, 'proposal');
  sendMessage_(
    chatId,
    CashflowEngine.renderText(w) + '\n\n📄 Строка месяца записана в Monthly_Cycles со статусом <b>proposal</b>.',
    monthButtons_(w.monthKey)
  );
}

function monthButtons_(monthKey) {
  return [
    { text: '✅ Apply to Sheet', callback_data: 'apply_month:' + monthKey },
    { text: '✏️ Edit Commitments', url: sheetUrl_() },
  ];
}

/** «6200 eur», «6200», «6200 EUR бонус Q4» → {incomeAmount, incomeCurrency}. */
function parseIncomeArgs_(args) {
  if (!args) return { incomeAmount: null, incomeCurrency: null };
  const amount = parseAmount_(args);
  if (amount === null) return { incomeAmount: null, incomeCurrency: null };
  return {
    incomeAmount: amount,
    incomeCurrency: detectCurrency_(args, getSetting_('INCOME_CURRENCY', CONFIG.PROFILE.INCOME_CURRENCY)),
  };
}

/** /spent — быстрая трата в недельный учёт. */
function cmdSpent_(chatId, args) {
  if (!args) throw new Error('Формат: /spent 3200 [₽/kgs/$] [заметка]');
  const parsed = parseTypedExpense_(args);
  if (!parsed) throw new Error('Не понял сумму. Пример: /spent 3200 или /spent 500 kgs');
  const status = CashflowEngine.logWeeklyExpense({
    amount: parsed.total_spent, currency: parsed.currency, note: args, source: 'manual',
  });
  MetricsEngine.logOnce('weekly_answer:' + weekKey_(new Date()), 'manual');
  sendMessage_(chatId,
    '🧾 Записано: ' + fmtMoney_(parsed.total_spent, parsed.currency) + '\n\n' +
    CashflowEngine.renderWeeklyText(status));
}

function cmdWeek_(chatId) {
  sendMessage_(chatId, CashflowEngine.renderWeeklyText(CashflowEngine.weeklyStatus()));
}

/** /prepay — Workflow C: ЧДП со снижением платежа, срок сохраняется. */
function cmdPrepay_(chatId, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) throw new Error('Формат: /prepay sber 50000 (или tbank)');
  const debtId = parts[0];
  const amount = parseAmount_(parts[1]);
  if (!amount) throw new Error('Не понял сумму: ' + escHtml_(parts[1]));
  const r = DebtEngine.registerPrepay(debtId, amount);
  const arb = DebtEngine.arbitrage(r.amount);
  const dep = InvestNetWorth.depositsSummary();
  sendMessage_(
    chatId,
    '💸 <b>ЧДП ' + escHtml_(r.name) + '</b>\n' +
    'Списано досрочно: ' + fmtMoney_(r.amount, 'RUB') + '\n' +
    'Остаток долга: ' + fmtMoney_(r.balanceBefore, 'RUB') + ' → <b>' + fmtMoney_(r.balanceAfter, 'RUB') + '</b>\n' +
    'Платёж (срок сохранён): ' + fmtMoney_(r.paymentBefore, 'RUB') + ' → <b>' + fmtMoney_(r.paymentAfter, 'RUB') + '</b>' +
    (r.paymentSaved > 0 ? ' (−' + fmtMoney_(r.paymentSaved, 'RUB') + '/мес)' : '') + '\n\n' +
    '🔗 Commitments_Registry обновится сам (формулы ссылаются на Debt_Engine).\n' +
    '⚖️ ' + (arb.depositWins ? '⚠️ ' : '✅ ') + arb.verdict +
    (dep.count ? '\n🏦 Уже на вкладах: ' + fmtMoney_(dep.totalUSD, 'USD') + ' под ~' + fmtPct_(dep.avgRate) +
      ' — арбитраж фактически работает.' : '')
  );
}

function cmdMortgage_(chatId, args) {
  const parts = args.split(/\s+/);
  if (!parts[0]) throw new Error('Формат: /mortgage sber [сумма] — сумма не обязательна');
  const after = DebtEngine.logPayment(parts[0], parts[1] ? parseAmount_(parts[1]) : undefined);
  sendMessage_(chatId,
    '🏦 ' + escHtml_(after.name) + ' — платёж учтён.\n' +
    'Остаток: ' + fmtMoney_(after.balance, 'RUB') + ' · платёж: ' + fmtMoney_(after.payment, 'RUB'));
}

function cmdInvest_(chatId) {
  sendMessage_(chatId, InvestNetWorth.renderText());
}

/** /fx — анализ валют: перцентили, RSI, прогноз и тайминг конвертаций. */
function cmdFx_(chatId) {
  sendMessage_(chatId, FXAnalytics.renderText(FXAnalytics.build()));
}

/** /anomalies — проверка невозможных/подозрительных цифр. */
function cmdAnomalies_(chatId) {
  sendMessage_(chatId, AnomalyEngine.renderText());
}

/** /balance sber|tbank <остаток ₽> — сверка ипотеки с банком вручную. */
function cmdBalance_(chatId, args) {
  const parts = String(args || '').split(/\s+/);
  if (parts.length < 2 || !parseAmount_(parts[1])) {
    throw new Error('Формат: /balance sber 1234567 (или tbank)');
  }
  proposeReconciliation_(chatId, parts[0], parseAmount_(parts[1]));
}

/** /alias "кафе" Питание — переименование категории Vision на будущее. */
function cmdAlias_(chatId, args) {
  const m = String(args || '').match(/^"?([^"]+?)"?\s+"?([^"]+?)"?$/);
  if (!m || !m[1] || !m[2]) throw new Error('Формат: /alias "как распознал" "как правильно"');
  const from = m[1].trim(), to = m[2].trim();
  // защита от formula-injection: значения попадают в ячейки Settings
  if (/^[=+\-@\t\r]/.test(from) || /^[=+\-@\t\r]/.test(to)) {
    throw new Error('Значения не могут начинаться с = + - @');
  }
  if (from.length > 40 || to.length > 40) throw new Error('Слишком длинно (макс. 40 символов)');
  setSetting_('CAT_ALIAS_' + from.toLowerCase(), to);
  MetricsEngine.log('vision_fix:' + fmtISO_(new Date()), from + '→' + to);
  sendMessage_(chatId, '✅ Категория «' + escHtml_(from) + '» теперь записывается как «' + escHtml_(to) + '».');
}

/** /guide — интерактивный онбординг: что уже готово и следующий шаг (P2). */
function cmdGuide_(chatId) {
  const L = ['🧭 <b>Гид установки</b> — состояние и следующий шаг\n'];
  let step = 0;

  const token = getProp_(PROP.BOT_TOKEN, '');
  const chatIdProp = getProp_(PROP.CHAT_ID, '');
  const visionKey = getProp_(PROP.GEMINI_KEY, '') || getProp_(PROP.GROQ_KEY, '');
  L.push((token ? '✅' : '⬜') + ' 1. Токен бота (TELEGRAM_BOT_TOKEN)');
  L.push((chatIdProp ? '✅' : '⬜') + ' 2. Chat ID (TELEGRAM_CHAT_ID)');
  L.push((visionKey ? '✅' : '⬜') + ' 3. Ключ Vision (GEMINI_API_KEY или GROQ_API_KEY)');
  if (!token) step = 1; else if (!chatIdProp) step = 2; else if (!visionKey) step = 3;

  let sheetOk = false;
  try { ss_().getSheetByName(SHEETS.FX_SETTINGS).getRange('B2').getValue(); sheetOk = true; } catch (e) {}
  L.push((sheetOk ? '✅' : '⬜') + ' 4. Таблица создана (createSpreadsheet)');
  if (sheetOk && !step) step = 4;

  let hookOk = false;
  try { hookOk = !!tgCall_('getWebhookInfo', {}).url; } catch (e) {}
  L.push((hookOk ? '✅' : '⬜') + ' 5. Webhook привязан (деплой + setupWebhook)');
  if (hookOk && !step) step = 5;

  const mini = String(CONFIG.MINI_APP_URL || getSetting_('MINI_APP_URL', ''));
  L.push((mini ? '✅' : '⬜') + ' 6. Mini App подключён (ключ MINI_APP_URL)');
  if (mini && !step) step = 6;

  const next = {
    1: '→ Получите токен у @BotFather и добавьте в Script Properties (SETUP.md, Шаг 1 и 3).',
    2: '→ Узнайте chat_id у @userinfobot и добавьте TELEGRAM_CHAT_ID.',
    3: '→ Создайте ключ на aistudio.google.com/apikey (или console.groq.com) и добавьте.',
    4: '→ Выполните функцию createSpreadsheet в редакторе Apps Script.',
    5: '→ Разверните Web App и выполните setupWebhook (SETUP.md, Шаг 5).',
    6: '→ Всё готово! Дальше: /income 6200 eur, /plan, /fx. Проверка здоровья: /sync и securityAudit.',
    0: '→ Начните с Шага 1 в SETUP.md.',
  }[step];
  L.push('\n<b>Следующий шаг:</b>\n' + next);
  sendMessage_(chatId, L.join('\n'));
}

/** /metrics — продуктовые метрики (weekly response, vision, cascade, savings). */
function cmdMetrics_(chatId) {
  const wrr = MetricsEngine.weeklyResponseRate();
  const va = MetricsEngine.visionAccuracy();
  const L = ['📊 <b>Метрики продукта</b>\n'];
  L.push('Воскресные опросы: ' + (wrr === null ? 'ещё не было' : fmtPct_(wrr, 0) + ' ответов (' +
    MetricsEngine.byPrefix('weekly_ask:').length + ' нед.) — цель >80%'));
  if (va) L.push('Vision: исправлений ' + va.fixes + ' из ' + (va.fixes + va.visionRows) + ' записей (' +
    fmtPct_(va.fixRate, 0) + ') — цель <10%');
  const sr = MetricsEngine.value('savings_rate:');
  if (sr !== null) L.push('Savings rate (посл. месяц): ' + fmtPct_(Number(sr)));
  const cascades = MetricsEngine.byPrefix('cascade_applied:').filter(function (c) {
    return c.key.indexOf(':observed') === -1; // наблюдения digest не считаем применениями
  });
  if (cascades.length) {
    const applied = cascades.filter(function (c) { return c.value === '1'; }).length;
    L.push('Каскад применён: ' + applied + ' из ' + cascades.length + ' мес.');
  }
  sendMessage_(chatId, L.join('\n'));
}

function cmdCash_(chatId, args) {
  const parsed = parseTypedExpense_(args || '');
  if (!parsed) throw new Error('Формат: /cash 12000 kgs (валюта: usd/eur/rub/kgs)');
  const totalUSD = InvestNetWorth.setCash(parsed.total_spent, parsed.currency);
  sendMessage_(chatId, '💵 Кэш ' + parsed.currency + ' = ' + fmtMoney_(parsed.total_spent, parsed.currency) +
    ' · всего кэша: ' + fmtMoney_(totalUSD, 'USD') + '\n\n' +
    InvestNetWorth.renderNetWorthText(InvestNetWorth.netWorth()));
}

function cmdStatus_(chatId) {
  const debts = DebtEngine.replayAll();
  const nw = InvestNetWorth.takeSnapshot();
  const weekly = CashflowEngine.weeklyStatus();
  const L = [InvestNetWorth.renderNetWorthText(nw), ''];
  if (getFx_().FALLBACK_USED) {
    L.push('⚠️ Курсы GOOGLEFINANCE недоступны — цифры на резервных значениях (примерные).');
    L.push('');
  }
  debts.forEach(function (d) {
    const p = DebtEngine.projection(d, 0);
    L.push('🏦 ' + escHtml_(d.name) + ': ' + fmtMoney_(d.balance, 'RUB') +
      ' под ' + fmtPct_(d.rate) + ' · платёж ' + fmtMoney_(DebtEngine.normalizedMonthlyRUB(d), 'RUB') + '/мес' +
      ' · погашение ' + p.payoffISO + ' (' + p.monthsLeft + ' мес)');
  });
  L.push('');
  L.push(CashflowEngine.renderWeeklyText(weekly));
  sendMessage_(chatId, L.join('\n'));
}

function cmdSync_(chatId) {
  const posted = DebtEngine.checkDuePayments();
  DebtEngine.replayAll();
  InvestNetWorth.takeSnapshot();
  sendMessage_(chatId,
    '🔄 <b>Sync выполнен</b>\n' +
    (posted.length ? 'Автопостановка платежей: ' + escHtml_(posted.join(', ')) + '\n' : '') +
    'Долги пересчитаны, Net Worth снапшот обновлён.\n\n' +
    InvestNetWorth.renderNetWorthText(InvestNetWorth.netWorth()));
}

function cmdApp_(chatId) {
  const base = String(CONFIG.MINI_APP_URL || getSetting_('MINI_APP_URL', ''));
  if (!base) {
    sendMessage_(chatId, 'Mini App ещё не подключён: укажите URL хостинга в листе FX_and_Settings (ключ MINI_APP_URL) — см. SETUP.md, Шаг 7.');
    return;
  }
  // токен доступа подставляется автоматически — владелец его даже не видит
  const rt = getProp_('TMA_READ_TOKEN', '');
  const url = base + (base.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(rt);
  sendMessage_(chatId, '📊 <b>Дашборд</b> — слайдеры сценариев, валютные сигналы, ЧДП-калькулятор, портфель и Net Worth.', [
    { text: ' Открыть дашборд', web_app: { url: url } },
  ]);
}

// ─────────────────────────── Callback-кнопки ───────────────────────────

function handleCallback_(cb) {
  const chatId = cb.message ? cb.message.chat.id : null;
  if (!chatId || !authorizeChat_(chatId)) return;
  const data = String(cb.data || '');

  if (data.indexOf('apply_month:') === 0) {
    const monthKey = data.split(':')[1];
    CashflowEngine.setMonthStatus(monthKey, 'applied');
    MetricsEngine.logOnce('cascade_applied:' + monthKey, 1);
    answerCallback_(cb.id, 'Applied ✅');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
    sendMessage_(chatId, '✅ Месяц ' + escHtml_(monthKey) + ' применён: каскад зафиксирован в Monthly_Cycles.');
    return;
  }

  // Сверка ипотек с банком (P1)
  if (data.indexOf('recon_apply:') === 0) {
    const parts = data.split(':'); // recon_apply:SBER:1234567
    try {
      const r = DebtEngine.reconcile(parts[1], parts[2]);
      answerCallback_(cb.id, 'Применено ✅');
      tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
      sendMessage_(
        chatId,
        r.unchanged
          ? '✅ ' + escHtml_(r.name) + ': остатки уже совпадали.'
          : (r.bigDrift ? '⚠️ <b>Большое расхождение (>20%)</b> — убедитесь, что это остаток ОСНОВНОГО долга, а не общая задолжённость с процентами.\n' : '') +
            '✅ ' + escHtml_(r.name) + ': остаток ' + fmtMoney_(r.before, 'RUB') + ' → <b>' + fmtMoney_(r.after, 'RUB') + '</b>' +
            ' (Δ ' + (r.drift > 0 ? '+' : '') + fmtMoney_(r.drift, 'RUB') + ')\n' +
            'Платёж не изменился; срок пересчитан: ~' + r.monthsLeft + ' мес (погашение к ' + r.payoffISO + ')'
      );
      MetricsEngine.logOnce('recon_ok:' + fmtMonthKey_(new Date()), parts[1]);
    } catch (e) {
      answerCallback_(cb.id, 'Ошибка');
      sendMessage_(chatId, '❌ ' + escHtml_(e.message));
    }
    return;
  }
  if (data === 'recon_ok') {
    MetricsEngine.logOnce('recon_ok:' + fmtMonthKey_(new Date()), 'manual');
    answerCallback_(cb.id, 'Записано ✅');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
    sendMessage_(chatId, '✅ Сверка зафиксирована. Хорошего месяца!');
    return;
  }
  if (data === 'recon_how') {
    answerCallback_(cb.id, '');
    sendMessage_(chatId,
      '📸 Просто пришлите скриншот экрана ипотеки (остаток долга) прямо в чат — ' +
      'бот распознает остаток, сравнит с движком и предложит применить.\n' +
      'Или вручную: /balance sber 1234567');
    return;
  }
  if (data === 'recon_cancel') {
    answerCallback_(cb.id, 'Отменено');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
    return;
  }

  answerCallback_(cb.id, '');
}

// ─────────────────────────── Скриншоты (Vision) ───────────────────────────

function handlePhoto_(chatId, fileId, mime) {
  try {
    tgCall_('sendChatAction', { chat_id: chatId, action: 'typing' });
    const file = downloadTelegramFile_(fileId); // валидирует, что это изображение
    const parsed = parseExpenseScreenshot_(file.base64, mime || file.mime);

    if (parsed.screen_type === 'debt_balance') return handleDebtBalancePhoto_(chatId, parsed);

    if (parsed.screen_type === 'other' || !parsed.total_spent) {
      sendMessage_(chatId,
        '🤖 Не нашёл на скриншоте ни аналитики расходов, ни остатка долга (провайдер: ' + parsed.provider + ').\n' +
        'Пришлите экран «Аналитика/Расходы за период» из MBANK или экран ипотеки с остатком долга.\n' +
        'Или введите сумму: /spent 3200');
      return;
    }

    const head = '🤖 <b>' + (parsed.provider === 'groq' ? 'Groq (резерв)' : 'Gemini') + ' разобрал скриншот</b>\n' +
      'Период: ' + escHtml_(parsed.period || '—') + ' · Валюта: ' + parsed.currency + '\n' +
      'Сумма: <b>' + fmtMoney_(parsed.total_spent, parsed.currency) + '</b>' +
      (parsed.top_categories.length
        ? '\nКатегории: ' + parsed.top_categories.map(function (c) {
            return escHtml_(c.category) + ' ' + fmtMoney_(c.amount, parsed.currency);
          }).join(' · ')
        : '');

    if (parsed.is_full_month_analytics) {
      sendMessage_(chatId, head + '\n\nℹ️ Это аналитика за <b>весь месяц</b> — не записываю её как недельную.' +
        ' Свежий месячный расход покажет /week.');
      return;
    }

    const c1 = parsed.top_categories[0], c2 = parsed.top_categories[1];
    const status = CashflowEngine.logWeeklyExpense({
      amount: parsed.total_spent,
      currency: parsed.currency,
      cat1: c1 ? c1.category + ' ' + round2_(c1.amount) : '',
      cat2: c2 ? c2.category + ' ' + round2_(c2.amount) : '',
      note: 'vision/' + parsed.provider + ' · file ' + fileId.slice(0, 12),
    });
    MetricsEngine.logOnce('weekly_answer:' + weekKey_(new Date()), parsed.provider);
    sendMessage_(chatId, head + '\n\n' + CashflowEngine.renderWeeklyText(status));
  } catch (err) {
    console.error('photo: ' + err.message);
    sendMessage_(chatId, '😕 ' + escHtml_(err.message) +
      '\nПопробуйте переснять скриншот (полный экран аналитики) или введите сумму: /spent 3200');
  }
}

/** Скриншот остатка ипотеки → сверка Debt_Engine (P1: «просто пришли скрин»). */
function handleDebtBalancePhoto_(chatId, parsed) {
  if (!parsed.debt_balance_rub) {
    sendMessage_(chatId, '🏦 Вижу экран ипотеки, но остаток долга не распознан.\n' +
      'Введите вручную: /balance sber 1234567 (или tbank)');
    return;
  }
  const debtId = debtIdFromBank_(parsed.bank);
  if (!debtId) {
    sendMessage_(
      chatId,
      '🏦 Остаток долга на скриншоте: <b>' + fmtMoney_(parsed.debt_balance_rub, 'RUB') + '</b>\n' +
      'Банк не распознан — какая это ипотека?',
      [
        { text: 'Сбербанк', callback_data: 'recon_apply:SBER:' + parsed.debt_balance_rub },
        { text: 'Т-Банк', callback_data: 'recon_apply:TBANK:' + parsed.debt_balance_rub },
      ]
    );
    return;
  }
  proposeReconciliation_(chatId, debtId, parsed.debt_balance_rub);
}

/** Сравнить факт с движком и предложить применить. */
function proposeReconciliation_(chatId, debtId, actualRUB) {
  const debt = DebtEngine.getDebt(debtId);
  const drift = actualRUB - debt.balance;
  const text =
    '🏦 <b>' + escHtml_(debt.name) + '</b>\n' +
    'В движке: ' + fmtMoney_(debt.balance, 'RUB') + '\n' +
    'На скриншоте: <b>' + fmtMoney_(actualRUB, 'RUB') + '</b>\n' +
    (Math.abs(drift) < 1
      ? '✅ Совпадает — ничего делать не нужно.'
      : 'Δ ' + (drift > 0 ? '+' : '') + fmtMoney_(drift, 'RUB') + ' — применить фактический остаток?');
  if (Math.abs(drift) < 1) { sendMessage_(chatId, text); return; }
  sendMessage_(chatId, text, [
    { text: '✅ Применить остаток', callback_data: 'recon_apply:' + debtId + ':' + Math.round(actualRUB) },
    { text: 'Отмена', callback_data: 'recon_cancel' },
  ]);
}

// ─────────────────────────── Свободный текст ───────────────────────────

function handleFreeText_(chatId, text) {
  const state = getBotState_();

  if (state.mode === 'await_week') {
    if (/^(0|ноль|никак|нет)$/i.test(text.trim())) {
      setBotState_({});
      sendMessage_(chatId, '👌 Записано: трат нет.\n\n' +
        CashflowEngine.renderWeeklyText(CashflowEngine.weeklyStatus()));
      return;
    }
    const parsed = parseTypedExpense_(text);
    if (parsed) {
      setBotState_({});
      const status = CashflowEngine.logWeeklyExpense({
        amount: parsed.total_spent, currency: parsed.currency, note: 'weekly reply', source: 'chat',
      });
      MetricsEngine.logOnce('weekly_answer:' + weekKey_(new Date()), 'chat');
      sendMessage_(chatId, '🧾 Записано: ' + fmtMoney_(parsed.total_spent, parsed.currency) + '\n\n' +
        CashflowEngine.renderWeeklyText(status));
    } else {
      sendMessage_(chatId, 'Пришлите сумму (например <code>4350</code> или <code>3500 kgs</code>) или скриншот MBANK.');
    }
    return;
  }

  // вне контекста: если похоже на сумму — подсказываем команду
  if (parseTypedExpense_(text)) {
    sendMessage_(chatId, 'Похоже на сумму. Записать трату: /spent ' + escHtml_(text));
  }
}
