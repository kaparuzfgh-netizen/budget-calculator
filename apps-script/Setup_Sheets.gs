/**
 * Setup_Sheets.gs — self-contained инициализация таблицы.
 * Создаёт листы по схеме ТЗ, формулы GOOGLEFINANCE, ЧДП-калькулятор,
 * Arbitrage Monitor, сиды портфеля и график Net Worth. Идемпотентно:
 * уже заполненные листы не перезаписываются.
 *
 * Запуск: выбрать функцию setup() → Выполнить (один раз).
 */

function setup() {
  // WEBHOOK_SECRET и TMA_READ_TOKEN генерируются автоматически при первом запуске —
  // вручную в Script Properties добавлять нужно только токен бота, chat_id и ключ Gemini.
  ensureSecret_(PROP.WEBHOOK_SECRET, 32);
  ensureSecret_(PROP.TMA_READ_TOKEN, 24);

  const built = runWithLock_(function () {
    return {
      fx: buildOnce_(SHEETS.FX_SETTINGS, buildFxSettings_),
      // Debts СТРОГО раньше Commitments: реестр ссылается формулами на Debt_Engine,
      // а формула на несуществующий лист застынет как #REF!
      debts: buildOnce_(SHEETS.DEBTS, buildDebtEngine_),
      commitments: buildOnce_(SHEETS.COMMITMENTS, buildCommitments_),
      monthly: buildOnce_(SHEETS.MONTHLY, buildMonthlyCycles_),
      weekly: buildOnce_(SHEETS.WEEKLY, buildWeeklyExpenses_),
      portfolio: buildOnce_(SHEETS.PORTFOLIO, buildPortfolio_),
      networth: buildOnce_(SHEETS.NETWORTH, buildNetWorth_),
      fxhistory: buildOnce_(SHEETS.FX_HISTORY, buildFxHistory_),
      deposits: buildOnce_(SHEETS.DEPOSITS, buildDeposits_),
      metrics: buildOnce_(SHEETS.METRICS, buildMetrics_),
      opslog: buildOnce_(SHEETS.OPS_LOG, buildOpsLog_),
      opslogFmt: (function () { try { applyOpsLogFormatting_(sheet_(SHEETS.OPS_LOG)); return 'ok'; } catch (e) { return 'skip'; } })(),
      networthMigrated: migrateNetWorthSheet_(),
      triggers: installTriggers_(),
    };
  });
  let msg = 'Готово: ' + JSON.stringify(built) +
    '\nЛисты: ' + ss_().getSheets().map(function (s) { return s.getName(); }).join(', ');
  // Триггеры срабатывают по часовому поясу ПРОЕКТА — расхождение с таблицей ломает час опроса
  try {
    const stz = Session.getScriptTimeZone();
    const shz = ss_().getSpreadsheetTimeZone();
    if (stz && shz && stz !== shz) {
      msg += '\n⚠️ Часовой пояс проекта (' + stz + ') отличается от таблицы (' + shz +
        '). Установите пояс проекта: ⚙ Настройки проекта → Часовой пояс.';
    }
  } catch (e) { /* non-critical */ }
  console.log(msg);
  return msg;
}

/** Генерирует секрет, если его ещё нет в Script Properties. */
function ensureSecret_(key, length) {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty(key)) {
    let v = Utilities.getUuid().replace(/-/g, '');
    while (v.length < (length || 32)) v += Utilities.getUuid().replace(/-/g, '');
    p.setProperty(key, v.slice(0, length || 32));
  }
}

/**
 * Автоматическое создание таблицы Google Sheets (standalone-скрипт, без ручной
 * привязки): создаёт файл в Google Drive, запоминает SHEET_ID в Script Properties
 * и сразу строит все листы через setup(). Запускать один раз из редактора.
 */
function createSpreadsheet(name) {
  const ss = SpreadsheetApp.create(name || 'Budget Companion');
  PropertiesService.getScriptProperties().setProperty(PROP.SHEET_ID, ss.getId());
  setup();
  // удаляем служебный пустой лист, созданный Google по умолчанию
  ['Лист1', 'Sheet1'].forEach(function (def) {
    const sh = ss.getSheetByName(def);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  const msg = '✅ Таблица создана автоматически:\n' + ss.getUrl() + '\nSHEET_ID сохранён в Script Properties.';
  console.log(msg);
  return msg;
}

/** Вызывает builder только если лист пуст. */
function buildOnce_(code, builder) {
  const sh = sheet_(code);
  if (sh.getLastRow() > 0 || sh.getLastColumn() > 0) return 'exists';
  builder(sh);
  return 'created';
}

function boldHeader_(sh, cols) {
  sh.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

// ─────────────────────── FX_and_Settings ───────────────────────

/** Единственный источник строк конфигурации (используется сборкой и починкой). */
function fxSettingsRows_() {
  return [
    ['BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD],
    ['INCOME_CURRENCY', CONFIG.PROFILE.INCOME_CURRENCY],
    ['LIVING_CURRENCY', CONFIG.PROFILE.LIVING_CURRENCY],
    ['WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB],
    ['MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB],
    ['DEPOSIT_RATE_ANNUAL', CONFIG.ARBITRAGE.DEPOSIT_RATE_ANNUAL],
    ['CASH_USD', 0],
    ['TARGET_ETF', CONFIG.INVEST_SPLIT.broad_market_etf],
    ['TARGET_STOCKS', CONFIG.INVEST_SPLIT.growth_stocks],
    ['TARGET_CRYPTO', CONFIG.INVEST_SPLIT.crypto_assets],
    ['BONUS_PREPAY_SHARE', CONFIG.SURPLUS.BONUS_PREPAY_SHARE],
    ['BONUS_DCA_SHARE', CONFIG.SURPLUS.BONUS_DCA_SHARE],
    ['MINI_APP_URL', CONFIG.MINI_APP_URL],
  ];
}

function buildFxSettings_(sh) {
  sh.getRange('A1:B1').setValues([['Rate', 'Value']]).setFontWeight('bold');
  sh.getRange('A2:B5').setValues([
    ['EUR/USD', '=GOOGLEFINANCE("CURRENCY:EURUSD")'],
    ['USD/RUB', '=GOOGLEFINANCE("CURRENCY:USDRUB")'],
    ['USD/KGS', '=GOOGLEFINANCE("CURRENCY:USDKGS")'],
    ['EUR/RUB', '=B2*B3'],
  ]);
  sh.getRange('B2:B5').setNumberFormat('0.0000');

  sh.getRange('A7:B7').setValues([['Key', 'Value']]).setFontWeight('bold');
  const rows = fxSettingsRows_();
  sh.getRange(8, 1, rows.length, 2).setValues(rows); // размер всегда по массиву — рассинхрон невозможен
  sh.getRange('B8').setNumberFormat('#,##0.00');
  sh.getRange('B10:B12').setNumberFormat('#,##0.00');
  sh.getRange('B13').setNumberFormat('0.00%');
  sh.getRange('B14:B' + (7 + rows.length)).setNumberFormat('0.00');
  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(2, 110);
}

/**
 * Починка FX_and_Settings, если setup() упал на полпути (например, старая
 * версия бандла с жёстким диапазоном): восстанавливает формулы курсов
 * и добавляет только НЕДОСТАЮЩИЕ ключи — существующие значения не трогает.
 */
function repairSettings() {
  const sh = sheet_(SHEETS.FX_SETTINGS);
  sh.getRange('B2').setFormula('=GOOGLEFINANCE("CURRENCY:EURUSD")');
  sh.getRange('B3').setFormula('=GOOGLEFINANCE("CURRENCY:USDRUB")');
  sh.getRange('B4').setFormula('=GOOGLEFINANCE("CURRENCY:USDKGS")');
  sh.getRange('B5').setFormula('=B2*B3');
  const have = getSettings_();
  let added = 0;
  fxSettingsRows_().forEach(function (r) {
    if (have[r[0]] === undefined) { setSetting_(r[0], r[1]); added += 1; }
  });
  const msg = 'Формулы курсов восстановлены; добавлено недостающих ключей: ' + added;
  console.log(msg);
  return msg;
}

// ─────────────────────── Commitments_Registry ───────────────────────

function buildCommitments_(sh) {
  const headers = ['Category', 'Item Name', 'Base Amount', 'Currency', 'USD Equivalent', 'Due Day', 'Active'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);

  const usd = CONFIG.USD_COMMITMENTS;
  const rub = CONFIG.RUB_COMMITMENTS;
  const rows = [];
  usd.forEach(function (c) { rows.push([c.category, c.name, c.amount, 'USD', null, c.due_day, true]); });
  rub.forEach(function (c) { rows.push([c.category, c.name, c.amount, 'RUB', null, c.due_day, true]); });
  // Строки ипотек динамически связаны с Debt_Engine (Т-Банк нормализуется ×26/12)
  rows.push(['Mortgages', 'Ипотека Сбербанк (аннуитет)', null, 'RUB', null, 25, true]);
  rows.push(['Mortgages', 'Ипотека Т-Банк (раз в 2 недели ×26/12)', null, 'RUB', null, null, true]);
  sh.getRange(2, 1, rows.length, 7).setValues(rows);

  const firstRow = 2;
  const lastRow = firstRow + rows.length - 1; // включительно
  for (let r = firstRow; r <= lastRow; r++) {
    const cur = sh.getRange(r, 4).getValue();
    let usdFormula;
    if (cur === 'USD') usdFormula = '=C' + r;
    else if (cur === 'EUR') usdFormula = '=C' + r + '*FX_and_Settings!$B$2';
    else if (cur === 'RUB') usdFormula = '=C' + r + '/FX_and_Settings!$B$3';
    else usdFormula = '=C' + r + '/FX_and_Settings!$B$4';
    sh.getRange(r, 5).setFormula(usdFormula).setNumberFormat('#,##0.00');
    sh.getRange(r, 3).setNumberFormat('#,##0.00');
  }
  const sberRow = lastRow - 1; // платёж Сбербанка (аннуитет)
  const tbankRow = lastRow;    // Т-Банк, нормализация раз-в-2-недели ×26/12
  sh.getRange(sberRow, 3).setFormula('=Debt_Engine!$D$2');
  sh.getRange(tbankRow, 3).setFormula('=Debt_Engine!$D$3*26/12');
  sh.setColumnWidth(2, 260);
}

// ─────────────────────── Monthly_Cycles ───────────────────────

function buildMonthlyCycles_(sh) {
  const headers = [
    'Month (YYYY-MM)', 'Income Received', 'Currency', 'Income in USD',
    'Total Mandatory (USD)', 'Free Surplus (USD)',
    'To Debt Prepayment (USD)', 'To ETF (USD)', 'To Stocks (USD)', 'To Crypto (USD)', 'Status',
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('B2:B1000').setNumberFormat('#,##0.00');
  sh.getRange('D2:J1000').setNumberFormat('#,##0.00');
  sh.setColumnWidth(1, 130);
}

// ─────────────────────── Weekly_Expenses ───────────────────────

function buildWeeklyExpenses_(sh) {
  const headers = [
    'Date', 'Week #', 'Total Spent (KGS)', 'In RUB', 'In USD',
    'Top Category 1', 'Top Category 2', 'Weekly Budget Target ₽', 'Variance / Delta ₽', 'Receipt File ID / Note',
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('C2:E1000').setNumberFormat('#,##0.00');
  sh.getRange('H2:I1000').setNumberFormat('#,##0.00');
  sh.setColumnWidth(10, 220);
}

// ─────────────────────── Debt_Engine ───────────────────────

function buildDebtEngine_(sh) {
  // Блок 1: живое состояние ипотек
  const stateHeaders = ['Id', 'Name', 'Balance ₽', 'Payment ₽', 'Rate', 'Type',
    'Payments Made', 'Initial Balance ₽', 'Epoch', 'Maturity', 'Last Update'];
  sh.getRange(1, 1, 1, stateHeaders.length).setValues([stateHeaders]);
  sh.getRange(1, 1, 1, stateHeaders.length).setFontWeight('bold');

  CONFIG.DEBTS.forEach(function (d, i) {
    sh.getRange(2 + i, 1, 1, stateHeaders.length).setValues([[
      d.id, d.name, d.initial_balance_rub, d.payment_amount_rub, d.rate,
      d.payment_type, 0, d.initial_balance_rub, d.epoch, d.maturity || '', fmtISO_(new Date()),
    ]]);
  });
  sh.getRange('C2:D3').setNumberFormat('#,##0.00');
  sh.getRange('E2:E3').setNumberFormat('0.00%');
  DebtEngine.refreshDerivedState_(); // n (остаток периодов) и Live-пересчёт

  // Блок 2: ЧДП-калькулятор Сбербанка — формула аннуитета прямо в листе
  sh.getRange('A5').setValue('ЧДП-калькулятор (Сбербанк)').setFontWeight('bold');
  sh.getRange('A6:B10').setValues([
    ['Досрочный платёж L, ₽', 0],
    ['Осталось периодов n (движок)', 34.5],
    ['Новый платёж при фикс. сроке, ₽/мес', null],
    ['Экономия платежа, ₽/мес', null],
    ['Новый срок при фикс. платеже, мес', null],
  ]);
  sh.getRange('B6').setBackground('#fde68a'); // жёлтая ячейка ввода
  sh.getRange('B8').setFormula(
    '=IF($B$6<=0,$D$2,($C$2-$B$6)*($E$2/12)*POWER(1+$E$2/12,$B$7)/(POWER(1+$E$2/12,$B$7)-1))'
  ).setNumberFormat('#,##0.00');
  sh.getRange('B9').setFormula('=$D$2-$B$8').setNumberFormat('#,##0.00');
  sh.getRange('B10').setFormula(
    '=IF($B$6<=0,$B$7,-LN(1-($C$2-$B$6)*($E$2/12)/$D$2)/LN(1+$E$2/12))'
  ).setNumberFormat('0.0');

  // Блок 3: Arbitrage Monitor — вклад против досрочки Сбербанка
  sh.getRange('A12').setValue('Arbitrage Monitor').setFontWeight('bold');
  sh.getRange('A13:B16').setValues([
    ['Ставка вклада (годовых)', '=FX_and_Settings!$B$13'],
    ['Лучшая ставка ипотеки', '=MAX($E$2:$E$3)'],
    ['Годовой перевес вклада на L, ₽', null],
    ['Вердикт', null],
  ]);
  sh.getRange('B13:B14').setNumberFormat('0.00%');
  sh.getRange('B15').setFormula('=IF($B$13>$B$14,$B$6*($B$13-$B$14),0)').setNumberFormat('#,##0.00');
  sh.getRange('B16').setFormula(
    '=IF($B$13>$B$14,' +
    '"Deposit arbitrage active: "&TEXT($B$13,"0.0%")&" deposit yields +"&TEXT($B$15,"#,##0")&" ₽/yr more than paying Sberbank early.",' +
    '"Досрочное погашение выгоднее вклада.")'
  );

  // Блок 4: журнал событий (платежи/ЧДП) — источник roll-forward
  sh.getRange('A18').setValue('Event Log (платежи / ЧДП)').setFontWeight('bold');
  const logHeaders = ['Date', 'Debt', 'Event', 'Amount ₽', 'Balance After ₽', 'Payment After ₽', 'Source'];
  sh.getRange(19, 1, 1, logHeaders.length).setValues([logHeaders]).setFontWeight('bold');
  sh.getRange('D19:F1000').setNumberFormat('#,##0.00');
  sh.setColumnWidth(2, 220);
}

// ─────────────────────── Portfolio ───────────────────────

function buildPortfolio_(sh) {
  const headers = ['Ticker', 'Asset Class', 'Units', 'Avg Buy Price ($)', 'Current Price ($)',
    'Market Value ($)', 'PnL ($)', 'PnL (%)', 'Current Share (%)', 'Target Share (%)', 'Rebalance Delta ($)'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);

  // Сид: целевые доли в сумме = 100%. Units/Avg Buy заполняете своими данными.
  const rows = [
    ['VOO', 'broad_market_etf', 0, 0, CONFIG.INVEST_SPLIT.broad_market_etf],
    ['NVDA', 'growth_stocks', 0, 0, 0.115],
    ['TSLA', 'growth_stocks', 0, 0, 0.115],
    ['BTC', 'crypto_assets', 0, 0, 0.12],
    ['SOL', 'crypto_assets', 0, 0, 0.07],
  ];
  rows.forEach(function (r, i) {
    const row = i + 2;
    sh.getRange(row, 1, 1, 4).setValues([r.slice(0, 4)]);
    sh.getRange(row, 10).setValue(r[4]);
    // Цена: акции/ETF — GOOGLEFINANCE(ticker,"price"); крипта — CURRENCY:<TICKER>USD
    const price = r[1] === 'crypto_assets'
      ? '=IFERROR(GOOGLEFINANCE("CURRENCY:"&A' + row + '&"USD"),0)'
      : '=IFERROR(GOOGLEFINANCE(A' + row + ',"price"),0)';
    sh.getRange(row, 5).setFormula(price);
    sh.getRange(row, 6).setFormula('=C' + row + '*E' + row);
    sh.getRange(row, 7).setFormula('=F' + row + '-C' + row + '*D' + row);
    sh.getRange(row, 8).setFormula('=IFERROR(G' + row + '/(C' + row + '*D' + row + '),0)').setNumberFormat('0.00%');
    sh.getRange(row, 9).setFormula('=IFERROR(F' + row + '/SUM($F$2:$F$100),0)').setNumberFormat('0.00%');
    sh.getRange(row, 10).setNumberFormat('0.00%');
    sh.getRange(row, 11).setFormula('=J' + row + '*SUM($F$2:$F$100)-F' + row);
  });
  sh.getRange('C2:G100').setNumberFormat('#,##0.00');
  sh.getRange('K2:K100').setNumberFormat('#,##0.00');
}

// ─────────────────────── NetWorth_History ───────────────────────

function buildNetWorth_(sh) {
  const headers = ['Date', 'Cash USD', 'Deposits USD', 'Portfolio USD', 'Debt ₽', 'Debt USD', 'Net Worth USD'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('B2:G1000').setNumberFormat('#,##0.00');

  // Встроенный график Net Worth (BI прямо в таблице)
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange('A2:A1000'))
    .addRange(sh.getRange('G2:G1000'))
    .setOption('title', 'Net Worth, USD')
    .setOption('curveType', 'function')
    .setOption('legend', { position: 'none' })
    .setPosition(1, 9, 0, 0)
    .build();
  sh.insertChart(chart);
}

/** Миграция старых 6-колоночных таблиц NetWorth → 7 колонок (Deposits USD). */
function migrateNetWorthSheet_() {
  const sh = sheet_(SHEETS.NETWORTH);
  if (sh.getLastColumn() !== 6) return false;
  sh.insertColumnAfter(3); // после Cash USD
  sh.getRange(1, 4).setValue('Deposits USD');
  sh.getRange('B2:G1000').setNumberFormat('#,##0.00');
  return true;
}

// ─────────────────────── FX_History (180 дней для анализа/прогноза) ───────────────────────

/** Блоки истории GOOGLEFINANCE: пара → якорь формулы и колонки (Date, Close). */
const FX_HISTORY_BLOCKS = [
  { pair: 'EURUSD', anchor: 'A3', col: 1 },
  { pair: 'USDRUB', anchor: 'D3', col: 4 },
  { pair: 'USDKGS', anchor: 'G3', col: 7 },
  { pair: 'EURRUB', anchor: 'J3', col: 10 },
];

function buildFxHistory_(sh) {
  sh.getRange('A1:K1').setValues([['EUR/USD', '', '', 'USD/RUB', '', '', 'USD/KGS', '', '', 'EUR/RUB', '']])
    .setFontWeight('bold');
  sh.getRange('A2:K2').setValues([['Дата', 'Курс', '', 'Дата', 'Курс', '', 'Дата', 'Курс', '', 'Дата', 'Курс']])
    .setFontWeight('bold');
  FX_HISTORY_BLOCKS.forEach(function (b) {
    sh.getRange(b.anchor).setFormula(
      '=GOOGLEFINANCE("CURRENCY:' + b.pair + '","price",TODAY()-180,TODAY(),"DAILY")'
    );
  });
  sh.setFrozenRows(2);
}

// ─────────────────────── Deposits (вклады как актив) ───────────────────────

function buildDeposits_(sh) {
  const headers = ['Date Opened', 'Name', 'Amount', 'Currency', 'Rate', 'Maturity', 'Active'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('C2:C100').setNumberFormat('#,##0.00');
  sh.getRange('E2:E100').setNumberFormat('0.00%');
  sh.setColumnWidth(2, 220);
}

// ─────────────────────── Metrics (продуктовые метрики) ───────────────────────

function buildMetrics_(sh) {
  const headers = ['Date', 'Key', 'Value'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('A2:A10000').setNumberFormat('yyyy-mm-dd');
  sh.setColumnWidth(2, 200);
}

// ─────────────────────── Ops_Log (журнал операций и ошибок) ───────────────────────

function buildOpsLog_(sh) {
  const headers = ['Date', 'Level', 'Source', 'Message'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('A2:A20000').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.setColumnWidth(4, 420);
  applyOpsLogFormatting_(sh);
}

/** Подсветка уровней: ERROR — красным, WARN — янтарным. Идемпотентно. */
function applyOpsLogFormatting_(sh) {
  const range = sh.getRange('B2:B5000');
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('ERROR').setBackground('#7f1d1d').setFontColor('#fecaca')
      .setRanges([range]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('WARN').setBackground('#78350f').setFontColor('#fde68a')
      .setRanges([range]).build(),
  ]);
}

// ─────────────────────── Webhook ───────────────────────

/** Командное меню бота (автокомплит «/» в Telegram) — ставится setupBotProfile(). */
const BOT_COMMANDS = [
  { command: 'plan', description: 'Водопад месяца: доход → обязательства → каскад' },
  { command: 'income', description: 'Записать доход месяца, напр. 6200 eur' },
  { command: 'spent', description: 'Быстрая трата в недельный учёт' },
  { command: 'week', description: 'Бюджет недели/месяца и дневной лимит' },
  { command: 'fx', description: 'Валюты: прогноз и когда выгодно менять' },
  { command: 'prepay', description: 'ЧДП ипотеки, напр. sber 50000' },
  { command: 'balance', description: 'Сверка остатка ипотеки с банком' },
  { command: 'invest', description: 'Портфель и дрейф от целей 58/23/19' },
  { command: 'cash', description: 'Остаток кэша в валюте, напр. 12000 kgs' },
  { command: 'status', description: 'Net Worth: кэш + вклады + портфель − долг' },
  { command: 'anomalies', description: 'Проверка невозможных цифр' },
  { command: 'metrics', description: 'Метрики и savings rate' },
  { command: 'alias', description: 'Исправить категорию Vision' },
  { command: 'sync', description: 'Пересчёт долгов + снапшот Net Worth' },
  { command: 'guide', description: 'Гид установки: что готово и что дальше' },
  { command: 'help', description: 'Все команды' },
];

/**
 * Настройка профиля бота через Bot API (вместо ручного ввода в @BotFather):
 * командное меню, описание пустого чата и «О боте». Запускать один раз
 * после деплоя (картинка и кнопка Mini App — вручную, см. docs/BOT_SETUP.md).
 */
function setupBotProfile() {
  tgCall_('setMyCommands', { commands: BOT_COMMANDS });
  tgCall_('setMyDescription', {
    description: 'Личный финансовый движок: план месяца и каскад профицита, две ипотеки с ЧДП-калькулятором, траты по скриншоту MBANK (Gemini), валютные сигналы EUR→₽/сом/$, Net Worth и аномалии.\n\nНачните с /start — или просто пришлите скриншот.',
  });
  tgCall_('setMyShortDescription', {
    description: 'Личный финанс-компаньон: план → каскад → контроль. Google Sheets + Gemini, $0/мес',
  });
  logOps_('INFO', 'setup', 'bot profile updated (commands, description, about)');
  return '✅ Командное меню, описание пустого чата и «О боте» обновлены. Осталось вручную: иконка и кнопка Mini App (docs/BOT_SETUP.md).';
}

/** Привязка Telegram Webhook к Web App. Запускать после деплоя. */
function setupWebhook(url) {
  ensureSecret_(PROP.WEBHOOK_SECRET, 32); // страховка, если setup() ещё не выполнялся
  url = url || ScriptApp.getService().getUrl();
  if (!url || url.indexOf('script.google.com') === -1) {
    throw new Error('Разверните Web App и вызовите: setupWebhook("https://script.google.com/macros/s/.../exec")');
  }
  const secret = getProp_(PROP.WEBHOOK_SECRET, '');
  const full = url + (url.indexOf('?') > -1 ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
  const res = tgCall_('setWebhook', {
    url: full,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const me = tgCall_('getMe', {});
  console.log('Webhook: ' + JSON.stringify(res) + ' | bot @' + me.username);
  return 'Webhook привязан к @' + me.username;
}

/**
 * Внешний бэкап (вне Google!): CSV всех данных листов → zip →
 * 1) документом в Telegram-чат владельца (хранится в облаке Telegram);
 * 2) опционально в приватный репозиторий GitHub (GH_BACKUP_TOKEN + GH_BACKUP_REPO).
 * Автоматически 1-го числа из monthlyPlanLog; вручную — backupNow().
 * FX_History не выгружается: 180 дней курсов заново собирает GOOGLEFINANCE.
 */
function backupNow() {
  const exportSheets = [
    SHEETS.FX_SETTINGS, SHEETS.COMMITMENTS, SHEETS.MONTHLY, SHEETS.WEEKLY,
    SHEETS.DEBTS, SHEETS.PORTFOLIO, SHEETS.NETWORTH, SHEETS.DEPOSITS,
    SHEETS.METRICS, SHEETS.OPS_LOG,
  ];
  const files = [];
  exportSheets.forEach(function (code) {
    const csv = sheetToCsv_(sheet_(code));
    const name = SHEETS[code] || code;
    if (csv) files.push(Utilities.newBlob(csv, 'text/csv', name + '.csv'));
  });
  files.push(Utilities.newBlob(BACKUP_README_(), 'text/plain', 'RESTORE.txt'));
  const zipName = 'budget-backup-' + fmtISO_(new Date()) + '.zip';
  const zip = Utilities.zip(files, zipName);

  const chatId = getProp_(PROP.CHAT_ID, '');
  if (chatId) {
    tgSendDocument_(chatId, zip,
      '📦 Бэкап вне Google · ' + fmtISO_(new Date()) + '\n' +
      files.length + ' CSV (долги с журналом, траты, план, net worth, вклады, метрики)\n' +
      'Хранится в Telegram. Инструкция восстановления — RESTORE.txt внутри.');
  }
  const gh = ghBackup_(zip);
  logOps_('INFO', 'backup', zipName + ' → Telegram' + (gh ? ' + GitHub' : ''));
  return zipName + ' → Telegram' + (gh ? ' + GitHub' : '');
}

/** Значения листа → CSV (даты в ISO, кавычки экранированы). */
function sheetToCsv_(sh) {
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return '';
  return sh.getRange(1, 1, lastRow, lastCol).getValues().map(function (row) {
    return row.map(function (v) {
      let s = (v instanceof Date) ? fmtISO_(v) : (v === null || v === undefined ? '' : String(v));
      if (/[",;\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',');
  }).join('\r\n');
}

/** Инструкция по восстановлению — кладётся в zip. */
function BACKUP_README_() {
  return 'RESTORE — Personal Finance Companion\n' +
    '====================================\n' +
    'Внутри: CSV всех листов данных (значения, включая журнал Debt_Engine —\n' +
    'он полностью восстанавливает состояние ипотек через replay).\n\n' +
    'Как восстановиться (на новом Google-аккаунте):\n' +
    '1. Новый проект Apps Script → вставить BUNDLE.gs → секреты (SETUP.md).\n' +
    '2. createSpreadsheet() — создаст структуру листов.\n' +
    '3. Распаковать zip. Для каждого CSV: открыть соответствующий лист →\n' +
    '   Файл → Импорт → Загрузить → вставить в новый лист → заменить значения\n' +
    '   (строку заголовков пропустить, она уже есть).\n' +
    '4. Debt_Engine.csv — самый важный: строки 19+ (Event Log) вернут долги.\n' +
    '5. Выполнить setup() и /sync — движок пересчитает балансы replay-ом.\n\n' +
    'FX_History не выгружается: 180 дней курсов соберёт GOOGLEFINANCE.\n' +
    'Сгенерировано: ' + nowTz_();
}

/** Опциональная копия в приватный репозиторий GitHub (Contents API). */
function ghBackup_(zipBlob) {
  const token = getProp_('GH_BACKUP_TOKEN', '');
  const repo = getProp_('GH_BACKUP_REPO', '');
  if (!token || !repo) return false;
  const url = 'https://api.github.com/repos/' + repo + '/contents/backups/' + zipBlob.getName();
  const resp = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({
      message: 'backup ' + fmtISO_(new Date()),
      content: Utilities.base64Encode(zipBlob.getBytes()),
    }),
    muteHttpExceptions: true,
    deadline: CONFIG.HTTP_TIMEOUT_MS / 1000,
  });
  if (resp.getResponseCode() >= 300) {
    logOps_('WARN', 'backup', 'GitHub: HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 120));
    return false;
  }
  return true;
}

/** Готовые ссылки доступа: API + Mini App с уже подставленным токеном чтения. */
function getAccessInfo() {
  const base = String(CONFIG.MINI_APP_URL || getSetting_('MINI_APP_URL', ''));
  const rt = getProp_('TMA_READ_TOKEN', '');
  const api = ScriptApp.getService().getUrl() || '(сначала разверните Web App)';
  const mini = base
    ? base + (base.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(rt)
    : '(заполните MINI_APP_URL в листе FX_and_Settings после хостинга Mini App)';
  const msg = '🔗 <b>Доступ</b>\nAPI: <code>' + escHtml_(api) + '</code>\nMini App: <code>' + escHtml_(mini) + '</code>';
  console.log(msg.replace(/<[^>]+>/g, ''));
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (chatId) { try { sendMessage_(chatId, msg); } catch (e) { /* уже в логе */ } }
  return msg;
}

/** Диагностика: куда смотрит webhook и были ли ошибки доставки (секрет маскируется). */
function debugWebhook() {
  const info = tgCall_('getWebhookInfo', {});
  if (info && info.url) info.url = String(info.url).replace(/secret=[^&]+/i, 'secret=***');
  console.log(JSON.stringify(info, null, 2));
  return JSON.stringify(info);
}
