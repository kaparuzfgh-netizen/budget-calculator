#!/usr/bin/env node
/**
 * gen-golden.js — генерирует эталонный фикстур apps/api/test/domain/golden.legacy.json:
 * прогоняет НАСТОЯЩИЙ legacy-код (apps-script/*.gs через buildSource()) в vm-сандбоксе
 * с моками SpreadsheetApp и выгружает входы/выходы чистых функций для сверки с портом TS.
 *
 * Запуск из корня: npm run golden. Фикстура коммитится; CI её не пересчитывает.
 * Детерминизм: Date заморожена на FIXED_NOW, случайности нет → повторный запуск
 * даёт идентичный файл. NB: генерация чувствительна к TZ машины (legacy Date);
 * если файл дрейфует — регенерируй на CI-машине (UTC) или у владельца.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildSource } = require('./build-bundle');

const OUT = path.join(__dirname, '..', 'apps', 'api', 'test', 'domain', 'golden.legacy.json');
// Полдень по UTC — одна и та же календарная дата в TZ от UTC-11 до +12.
const FIXED_NOW = new Date(Date.UTC(2026, 9, 21, 12)); // 2026-10-21, среда
const FIXED_NOW_ISO = '2026-10-21';

// ── Мок-слой Sheets (компактная копия харнесса smoke-test.js) ──
function a1(ref) {
  const mm = ref.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  const c2n = (s) => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  const c1 = c2n(mm[1]), r1 = mm[2] ? +mm[2] : 1;
  return { r1, c1, r2: mm[4] ? +mm[4] : (mm[2] ? r1 : 1000000), c2: mm[3] ? c2n(mm[3]) : c1 };
}
class R2 {
  constructor(sh, r1, c1, nr, nc) { Object.assign(this, { sh, r1, c1, nr, nc }); }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sh.grid.set((this.r1 + i) + ':' + (this.c1 + j), x))); this.sh.touch(this.r1 + this.nr - 1, this.c1 + this.nc - 1); return this; }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const r = []; for (let j = 0; j < this.nc; j++) { const k = (this.r1 + i) + ':' + (this.c1 + j); r.push(this.sh.grid.has(k) ? this.sh.grid.get(k) : ''); } o.push(r); } return o; }
  setValue(v) { return this.setValues([[v]]); }
  setFormula(f) { return this.setValue(f); }
  getValue() { return this.getValues()[0][0]; }
  setNumberFormat() { return this; } setBackground() { return this; } setFontWeight() { return this; }
  setFontColor() { return this; } clearNote() { return this; } clear() { return this; }
}
class Sh2 {
  constructor(ss, name) { Object.assign(this, { ss, name, grid: new Map(), maxR: 0, maxC: 0 }); }
  touch(r, c) { this.maxR = Math.max(this.maxR, r); this.maxC = Math.max(this.maxC, c); }
  getLastRow() { return this.maxR; } getLastColumn() { return this.maxC; } getName() { return this.name; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const p = a1(a); return new R2(this, p.r1, p.c1, p.r2 - p.r1 + 1, p.c2 - p.c1 + 1); }
    if (c === undefined && d === undefined) return new R2(this, a, b, 1, 1);
    return new R2(this, a, b, c, d);
  }
  appendRow(v) { v.forEach((x, j) => this.grid.set((this.maxR + 1) + ':' + (j + 1), x)); this.touch(this.maxR + 1 > 1 ? this.maxR : 1, v.length); }
  setFrozenRows() {} setColumnWidth() {} insertChart() {} setConditionalFormatRules() {}
  newChart() { const s = { addRange: () => s, setOption: () => s, setPosition: () => s, setChartType: () => s, build: () => ({}) }; return s; }
}
class SS2 {
  constructor(n) { this.name = n; this.sheets = {}; this.url = 'https://t/' + n; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { if (this.sheets[n]) throw new Error('dup ' + n); this.sheets[n] = new Sh2(this, n); return this.sheets[n]; }
  getSheets() { return Object.values(this.sheets); }
  deleteSheet(sh) { delete this.sheets[sh.name]; }
  getUrl() { return this.url; } getId() { return 'ID-' + this.name; } getName() { return this.name; }
  getSpreadsheetTimeZone() { return 'Asia/Bishkek'; }
  newConditionalFormatRule() { const r = { whenTextEqualTo: () => r, setBackground: () => r, setFontColor: () => r, setRanges: () => r, build: () => ({}) }; return r; }
}
const props = new Map(), userProps = new Map();
let created = null;
const RealDate = Date;
// Date без аргументов → фиксированный момент; с аргументами — обычный.
function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(FIXED_NOW.getTime()); }
Object.getOwnPropertyNames(RealDate).forEach((k) => { if (k !== 'prototype' && k !== 'length' && k !== 'name') FakeDate[k] = RealDate[k]; });
FakeDate.prototype = RealDate.prototype;

const sb = {
  console, JSON, Math, Date: FakeDate, Number, String, Object, Array, isFinite, isNaN, parseInt, parseFloat,
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (k) => (props.has(String(k)) ? props.get(String(k)) : null), setProperty: (k, v) => props.set(String(k), String(v)), getProperties: () => Object.fromEntries(props) }),
    getUserProperties: () => ({ getProperty: (k) => (userProps.has(String(k)) ? userProps.get(String(k)) : null), setProperty: (k, v) => userProps.set(String(k), String(v)) }),
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Session: { getScriptTimeZone: () => 'Asia/Bishkek', getActiveUser: () => ({ getEmail: () => 'x@y.z' }) },
  Utilities: {
    formatDate: (d, tz, f) => { const p = (n) => String(n).padStart(2, '0'); return f.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate())).replace('HH', p.getHours ? p(d.getHours()) : '00').replace('mm', p(d.getMinutes())); },
    getUuid: () => 'u1', base64Encode: (s) => Buffer.from(s).toString('base64'), zip: (a, n) => ({ getName: () => n }), sleep() {},
  },
  ScriptApp: { WeekDay: { SUNDAY: 'SUNDAY' }, _t: [], newTrigger() { const t = { timeBased: () => t, onWeekDay: () => t, atHour: () => t, everyDays: () => t, onMonthDay: () => t, create: () => t }; return t; }, getProjectTriggers: () => [], deleteTrigger() {}, getService: () => ({ getUrl: () => '' }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 500, getContentText: () => '{}' }) },
  Charts: { ChartType: { LINE: 'LINE' } },
  MimeType: { GOOGLE_SHEETS: 'x' },
  SpreadsheetApp: {
    create(n) { created = new SS2(n); props.set('SHEET_ID', created.getId()); return created; },
    getActiveSpreadsheet() { return created; },
    openById(id) { if (!created || created.getId() !== id) throw new Error('no sheet ' + id); return created; },
    newConditionalFormatRule() { const r = { whenTextEqualTo: () => r, setBackground: () => r, setFontColor: () => r, setRanges: () => r, build: () => ({}) }; return r; },
  },
};
vm.createContext(sb);
vm.runInContext(buildSource(), sb);

// ── Сборка кейсов внутри vm ──
const gen = `
(function () {
  var cases = [];
  var push = function (fn, args, result) { cases.push({ fn: fn, args: args, result: result }); };

  // createSpreadsheet строит реальную структуру листов → getFx_/getSettingNum_ работают
  createSpreadsheet('GOLDEN');
  var fx = getFx_(); // fallback-значения из Config.gs (формулы в моке не считаются)

  // A. Аннуитет / инверсия — сетка
  [[1287312, 0.119, 12, 34.46], [500000, 0.16, 12, 48], [1200000, 0.0859, 26, 78],
   [2000000, 0.21, 12, 120], [300000, 0, 12, 36], [99999.55, 0.1549, 26, 52]]
    .forEach(function (a) {
      var p = DebtEngine.annuityPayment_(a[0], a[1], a[2], a[3]);
      push('annuityPayment', a, p);
      push('derivePeriods', [a[0], a[1], a[2], p], DebtEngine.derivePeriods_(a[0], a[1], a[2], p));
    });
  // края: платёж не покрывает проценты / нулевая ставка
  push('derivePeriods', [1000000, 0.12, 12, 9000], DebtEngine.derivePeriods_(1000000, 0.12, 12, 9000));
  push('annuityPayment', [0, 0.12, 12, 36], DebtEngine.annuityPayment_(0, 0.12, 12, 36));
  push('annuityPayment', [100000, 0.12, 12, 0], DebtEngine.annuityPayment_(100000, 0.12, 12, 0));

  // B. normalizedMonthly
  [{ type: 'monthly', payment: 44282 }, { type: 'biweekly', payment: 17314 }, { type: 'biweekly', payment: 1 }]
    .forEach(function (d) { push('normalizedMonthly', d, DebtEngine.normalizedMonthlyRUB(d)); });

  // C. projection — только числовые поля (payoffISO зависит от даты)
  [['monthly', 0.119, 1287312, 44282, 0], ['monthly', 0.119, 1287312, 44282, 50000],
   ['biweekly', 0.0859, 800000, 17314, 0], ['biweekly', 0.0859, 800000, 17314, 10000],
   ['monthly', 0.21, 250000, 15000, 0], ['monthly', 0.12, 100000, 900, 0]]
    .forEach(function (a) {
      var r = DebtEngine.projection({ rate: a[1], type: a[0], balance: a[2], payment: a[3] }, a[4]);
      push('projection', a, { periodsLeft: r.periodsLeft, monthsLeft: r.monthsLeft,
        totalInterestRUB: r.totalInterestRUB, monthlyPaymentRUB: r.monthlyPaymentRUB });
    });

  // D. arbitrage — суммы; ставки из результата (депозит из настроек, долг = max ставка)
  [0, 50000, 100000, 706000, 1500000].forEach(function (amt) {
    var r = DebtEngine.arbitrage(amt);
    push('arbitrage', { amount: amt, depositRate: r.depositRate, debtRate: r.bestMortgageRate },
      { depositYield: r.depositYieldRUB, interestSaved: r.interestSavedRUB, delta: r.deltaRUB, depositWins: r.depositWins });
  });

  // E. convert_ — сетка валют × несколько наборов курсов
  [{ EURUSD: 1.08, USDRUB: 90, USDKGS: 86 }, { EURUSD: 1.20, USDRUB: 75.5, USDKGS: 84.2 }]
    .forEach(function (fxo) {
      [[6200, 'EUR', 'USD'], [6200, 'EUR', 'RUB'], [15000, 'RUB', 'KGS'], [500, 'USD', 'EUR'],
       [1e6, 'KGS', 'RUB'], [0, 'EUR', 'USD'], [777.77, 'USD', 'USD']]
        .forEach(function (a) {
          push('convert', { amount: a[0], from: a[1], to: a[2], fx: fxo }, convert_(a[0], a[1], a[2], fxo));
        });
    });

  // F. computeWaterfall — настоящий вызов на созданной таблице.
  // В фикстуру — эффективные входы (настройки, реестр, fx) для маппинга в TS-вход.
  var reg = CashflowEngine.registrySummary();
  var s = getSettings_();
  var wfIn = {
    baseIncomeUsd: Number(s.BASE_INCOME_USD),
    mandatoryUsd: reg.total,
    livingCap: { amount: Number(s.MONTHLY_CAP_RUB), currency: 'RUB' },
    bonusPrepayShare: Number(s.BONUS_PREPAY_SHARE),
    bonusDcaShare: Number(s.BONUS_DCA_SHARE),
    dcaTargets: { broad_market_etf: Number(s.TARGET_ETF), growth_stocks: Number(s.TARGET_STOCKS), crypto_assets: Number(s.TARGET_CRYPTO) },
    fx: fx,
  };
  [{}, { incomeAmount: 6200, incomeCurrency: 'EUR' }, { incomeAmount: 7500, incomeCurrency: 'EUR' },
   { incomeAmount: 500000, incomeCurrency: 'RUB' }, { incomeAmount: 450000, incomeCurrency: 'KGS' },
   { incomeAmount: 4000, incomeCurrency: 'USD' },
   { incomeAmount: 7000, incomeCurrency: 'EUR', extraPrepayRUB: 80000, extraDcaUSD: 500 }]
    .forEach(function (o) {
      var w = CashflowEngine.computeWaterfall(o);
      push('waterfall', { opts: o, resolved: wfIn }, {
        incomeAmount: w.income, incomeCurrency: w.incomeCurrency,
        incomeUSD: w.incomeUSD, livingUSD: w.livingUSD, surplusUSD: w.surplusUSD,
        bonusDeltaUSD: w.bonusDeltaUSD, toPrepayUSD: w.toPrepayUSD, toDcaUSD: w.toDcaUSD, split: w.split });
    });

  // G. replayAll — вносим события в журнал и снимаем состояние.
  // Параметры долгов из CONFIG + события — TS-сторона воспроизводит replay().
  var debtsCfg = {};
  CONFIG.DEBTS.forEach(function (d) {
    debtsCfg[d.id] = { rate: d.rate, frequency: d.payment_type, initialBalance: d.initial_balance_rub, initialPayment: d.payment_amount_rub };
  });
  var debtSh = ss_().getSheetByName(SHEETS.DEBTS);
  var evs = [
    ['SBER', 'payment', 44282], ['SBER', 'payment', 44282], ['SBER', 'prepay', 100000],
    ['SBER', 'payment', 0],       // нулевая сумма — должна пропускаться
    ['SBER', 'reconcile', 1100000], ['SBER', 'payment', 30000],
    ['TBANK', 'payment', 17314], ['TBANK', 'payment', 17314], ['TBANK', 'prepay', 50000], ['TBANK', 'payment', 17314],
  ];
  var d0 = new Date(Date.UTC(2026, 8, 25, 12));
  // журнал — явными строками с LOG_FIRST_ROW=20 (appendRow в моке не двигает maxR)
  evs.forEach(function (e, i) {
    debtSh.getRange(20 + i, 1, 1, 4).setValues([[new Date(d0.getTime() + i * 86400000 * 7), e[0], e[1], e[2]]]);
  });
  DebtEngine.replayAll();
  DebtEngine.getDebts().forEach(function (d) {
    push('replay', { params: debtsCfg[d.id], events: evs.filter(function (e) { return e[0] === d.id; })
        .map(function (e) { return { kind: e[1], amount: e[2] }; }) },
      { balance: d.balance, payment: d.payment, paymentsMade: d.paymentsMade });
  });
  // пустой журнал — начальное состояние
  push('replay', { params: debtsCfg.SBER, events: [] }, (function () {
    var p = debtsCfg.SBER; return { balance: p.initialBalance, payment: p.initialPayment, paymentsMade: 0 };
  })());

  // H. weeklyStatus — строки трат (r[3] = сумма в бюджетной валюте) + замороженный now.
  var wk = ss_().getSheetByName(SHEETS.WEEKLY);
  var exp = [
    ['2026-10-19T12:00:00', 3000],  // пн текущей ISO-недели
    ['2026-10-21T12:00:00', 4500],  // today (ср)
    ['2026-10-18T12:00:00', 7000],  // прошлая ISO-неделя, тот же месяц
    ['2026-09-30T12:00:00', 9999],  // прошлый месяц
  ];
  // строки трат явными setValues (r[0]=дата, r[3]=сумма в валюте бюджета)
  exp.forEach(function (e, i) { wk.getRange(2 + i, 1, 1, 4).setValues([[new Date(e[0]), '', 0, e[1]]]); });
  var st = CashflowEngine.weeklyStatus();
  push('weeklyStatus', { today: '${FIXED_NOW_ISO}', expenses: exp.map(function (e) { return { date: e[0].slice(0, 10), amount: e[1] }; }),
      monthlyCap: Number(s.MONTHLY_CAP_RUB), weeklyBudget: Number(s.WEEKLY_BUDGET_RUB) },
    { weekSpent: st.weekRUB, monthSpent: st.monthRUB, burnRate: st.burnRate, dailyAllowance: st.dailyAllowanceRUB, daysLeft: st.daysLeft });

  return { generatedWith: 'legacy apps-script @ vm mock, fixed now ${FIXED_NOW_ISO}', cases: cases };
})()`;

const out = vm.runInContext(gen, sb);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('✅ ' + path.relative(process.cwd(), OUT) + ' (' + out.cases.length + ' кейсов)');
