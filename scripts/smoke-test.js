#!/usr/bin/env node
/**
 * smoke-test.js — проверки бэкенда без Google (запуск: node scripts/smoke-test.js).
 *
 * Часть A (структура): BUNDLE парсится; нет дубликатов top-level символов;
 * жёсткие setValues-диапазоны согласованы с массивами.
 * Часть B (математика): аннуитет ±5 ₽, инверсия срока, ЧДП.
 * Часть C (полная эмуляция Apps Script): мок SpreadsheetApp/Properties/ScriptApp
 *   прогоняет createSpreadsheet → setup → повторный setup → сценарий поломки
 *   (repairSettings) → движки. Именно эта часть ловит баги класса
 *   «SHEETS[code] от значения» и «PROP без ключа» до деплоя.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'apps-script', 'BUNDLE.gs'), 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, d) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d !== undefined && d !== null ? '  [' + d + ']' : '')); };

// ── Часть A: структура ──
try { new (vm.Script)(src); ck('A1. BUNDLE парсится', true); }
catch (e) { ck('A1. BUNDLE парсится', false, e.message); }

const decl = new Map();
const reDecl = /^(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm;
let m;
while ((m = reDecl.exec(src))) decl.set(m[1] || m[2], (decl.get(m[1] || m[2]) || 0) + 1);
const dupes = [...decl.entries()].filter(([, n]) => n > 1);
ck('A2. нет дубликатов top-level символов (' + decl.size + ')', dupes.length === 0, dupes.map(([n, c]) => n + '×' + c).join(', ') || '—');

const setupSrc = fs.readFileSync(path.join(root, 'apps-script', 'Setup_Sheets.gs'), 'utf8');
[[/getRange\('A2:B5'\)\.setValues\(\[([\s\S]*?)\]\);/, 4, 'A2:B5 (курсы)'],
 [/getRange\('A6:B10'\)\.setValues\(\[([\s\S]*?)\]\);/, 5, 'A6:B10 (ЧДП-калькулятор)'],
 [/getRange\('A13:B16'\)\.setValues\(\[([\s\S]*?)\]\);/, 4, 'A13:B16 (арбитраж)']].forEach(([re, exp, label]) => {
  const mm = setupSrc.match(re);
  const count = mm ? ((mm[1].match(/^[ \t]*\[/gm) || []).length || 1) : -1;
  ck('A3. ' + label + ': строк ' + count, count === exp, count + ' ≠ ' + exp);
});
ck('A4. конфигурация: динамический диапазон rows.length', /getRange\(8,\s*1,\s*rows\.length,\s*2\)/.test(setupSrc));

// ── Часть B: чистая математика ──
function extractMethod(name) {
  const re = new RegExp(name + '_: function[^{]*\\{[\\s\\S]*?\\n  \\},');
  const mm = src.match(re);
  if (!mm) throw new Error('метод ' + name + ' не найден');
  return mm[0].replace(name + '_: function', 'function').replace(/\n  \},$/, '\n  }');
}
const mathSb = { console, Math, Date };
vm.createContext(mathSb);
try {
  vm.runInContext('globalThis.annuity=' + extractMethod('annuityPayment') + ';globalThis.derivePeriods=' + extractMethod('derivePeriods') + ';', mathSb);
  const { annuity, derivePeriods } = mathSb;
  const nSber = derivePeriods(1287312, 0.119, 12, 44282);
  ck('B1. аннуитет Сбербанка = 44 282 ±5 ₽', Math.abs(annuity(1287312, 0.119, 12, nSber) - 44282) < 5, annuity(1287312, 0.119, 12, nSber).toFixed(0));
  ck('B2. ЧДП 706к → ~19 996 ±5 ₽', Math.abs(annuity(1287312 - 706000, 0.119, 12, nSber) - 19996) < 5);
  ck('B3. инверсия срока n≈34.5', Math.abs(nSber - 34.5) < 0.1, nSber.toFixed(2));
} catch (e) { ck('B. математика', false, e.message); }

// ── Часть C: полная эмуляция GAS ──
function a1(ref) {
  const mm = ref.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  if (!mm) throw new Error('bad A1: ' + ref);
  const c2n = (s) => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  const c1 = c2n(mm[1]), r1 = mm[2] ? +mm[2] : 1;
  return { r1, c1, r2: mm[4] ? +mm[4] : (mm[2] ? r1 : 1000000), c2: mm[3] ? c2n(mm[3]) : c1 };
}
class Range2 {
  constructor(sh, r1, c1, nr, nc) { Object.assign(this, { sh, r1, c1, nr, nc }); }
  setValues(vals) {
    const rng = this;
    if (vals.length !== this.nr || vals.some((v) => v.length !== rng.nc)) {
      throw new Error('DIMENSION MISMATCH @' + this.sh.name + '!r' + this.r1 + ': ' + vals.length + 'x' + vals[0].length + ' ≠ ' + this.nr + 'x' + this.nc);
    }
    vals.forEach((row, i) => row.forEach((v, j) => rng.sh.grid.set((rng.r1 + i) + ':' + (rng.c1 + j), v)));
    this.sh.touch(this.r1 + this.nr - 1, this.c1 + this.nc - 1);
    return this;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const k = (this.r1 + i) + ':' + (this.c1 + j); row.push(this.sh.grid.has(k) ? this.sh.grid.get(k) : ''); } out.push(row); }
    return out;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFormula(f) { return this.setValue(f); }
  getValue() {
    if (this.nr < 1 || this.nc < 1) throw new Error('ZERO RANGE @' + this.sh.name + ' r' + this.r1 + 'c' + this.c1 + ' nr=' + this.nr + ' nc=' + this.nc);
    return this.getValues()[0][0];
  }
  setNumberFormat() { return this; } setBackground() { return this; } setFontWeight() { return this; }
  setFontColor() { return this; } clearNote() { return this; }
  clear() { return this; }
}
class Sheet2 {
  constructor(ss, name) { Object.assign(this, { ss, name, grid: new Map(), maxR: 0, maxC: 0 }); }
  touch(r, c) { this.maxR = Math.max(this.maxR, r); this.maxC = Math.max(this.maxC, c); }
  getLastRow() { return this.maxR; } getLastColumn() { return this.maxC; } getName() { return this.name; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const p = a1(a); return new Range2(this, p.r1, p.c1, p.r2 - p.r1 + 1, p.c2 - p.c1 + 1); }
    if (c === undefined && d === undefined) return new Range2(this, a, b, 1, 1); // getRange(row, col)
    return new Range2(this, a, b, c, d);
  }
  appendRow(vals) { const self = this; vals.forEach((v, j) => self.grid.set((self.maxR + 1) + ':' + (j + 1), v)); this.touch(this.maxR + 1 > 1 ? this.maxR : 1, vals.length); }
  setFrozenRows() {} setColumnWidth() {} insertChart() {}
  setConditionalFormatRules() {}
  newChart() { const s = { addRange: () => s, setOption: () => s, setPosition: () => s, setChartType: () => s, build: () => ({}) }; return s; }
}
class SS2 {
  constructor(name) { this.name = name; this.sheets = {}; this.url = 'https://test/' + name; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { if (this.sheets[n]) throw new Error('sheet exists: ' + n); this.sheets[n] = new Sheet2(this, n); return this.sheets[n]; }
  getSheets() { return Object.values(this.sheets); }
  deleteSheet(sh) { delete this.sheets[sh.name]; }
  getUrl() { return this.url; } getId() { return 'ID-' + this.name; } getName() { return this.name; }
  getSpreadsheetTimeZone() { return 'Asia/Bishkek'; }
  setConditionalFormatRules() {}
  newConditionalFormatRule() { const r = { whenTextEqualTo: () => r, setBackground: () => r, setFontColor: () => r, setRanges: () => r, build: () => ({}) }; return r; }
}
const props = new Map(), userProps = new Map();
let created = null;
const sb = {
  console, JSON, Math, Date, Number, String, Object, Array, isFinite, isNaN, parseInt, parseFloat,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(String(k)) ? props.get(String(k)) : null),
      setProperty: (k, v) => props.set(String(k), String(v)),
      getProperties: () => Object.fromEntries(props),
    }),
    getUserProperties: () => ({
      getProperty: (k) => (userProps.has(String(k)) ? userProps.get(String(k)) : null),
      setProperty: (k, v) => userProps.set(String(k), String(v)),
    }),
  },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Session: { getScriptTimeZone: () => 'Asia/Bishkek', getActiveUser: () => ({ getEmail: () => 'x@y.z' }) },
  Utilities: {
    formatDate: (d, tz, f) => { const p = (n) => String(n).padStart(2, '0'); return f.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate())).replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())); },
    getUuid: () => 'u' + Math.random().toString(36).slice(2),
    base64Encode: (s) => Buffer.from(s).toString('base64'),
    zip: (a, n) => ({ name: n, getBytes: () => Buffer.from('zip'), getName: () => n }),
    sleep() {},
  },
  ScriptApp: {
    WeekDay: { SUNDAY: 'SUNDAY', MONDAY: 'MONDAY' }, _trig: [],
    newTrigger(f) { const t = { timeBased: () => t, onWeekDay: () => t, atHour: () => t, everyDays: () => t, onMonthDay: () => t, create() { sb.ScriptApp._trig.push(f); return t; } }; return t; },
    getProjectTriggers: () => sb.ScriptApp._trig.map((f) => ({ getHandlerFunction: () => f })),
    deleteTrigger() {}, getService: () => ({ getUrl: () => '' }),
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 500, getContentText: () => '{}' }) },
  Charts: { ChartType: { LINE: 'LINE' } },
  MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
  SpreadsheetApp: {
    create(n) { created = new SS2(n); props.set('SHEET_ID', created.getId()); return created; },
    getActiveSpreadsheet() { return created; },
    openById(id) { if (!created || created.getId() !== id) throw new Error('no sheet ' + id); return created; },
    newConditionalFormatRule() {
      const r = { whenTextEqualTo: () => r, setBackground: () => r, setFontColor: () => r, setRanges: () => r, build: () => ({}) };
      return r;
    },
  },
};
vm.createContext(sb);
const testC = `
;
globalThis.__C = { log: [], pass: 0, fail: 0 };
var ck = function(n, c, d){ __C[c ? 'pass' : 'fail']++; __C.log.push((c ? 'PASS' : 'FAIL') + '  ' + n + ((d !== undefined && d !== null) ? '  [' + d + ']' : '')); };
var __pc = function(){ var c = 0; ['WEBHOOK_SECRET','TMA_READ_TOKEN','SHEET_ID'].forEach(function(k){ if (PropertiesService.getScriptProperties().getProperty(k)) c++; }); return c; };
createSpreadsheet('E2E');
var names = ss_().getSheets().map(function(s){ return s.getName(); });
['FX_and_Settings','Debt_Engine','Commitments_Registry','Monthly_Cycles','Weekly_Expenses','Portfolio','NetWorth_History','FX_History','Deposits','Metrics','Ops_Log'].forEach(function(n){
  ck('C. лист ' + n, names.indexOf(n) >= 0, names.join(','));
});
ck('C. листа undefined нет', names.indexOf('undefined') === -1, names.length + ' листов');
var fx = ss_().getSheetByName('FX_and_Settings');
ck('C. конфиг 13 ключей (до строки 20)', fx.getLastRow() >= 20, 'lastRow=' + fx.getLastRow());
ck('C. MINI_APP_URL в A20', String(fx.getRange('A20').getValue()) === 'MINI_APP_URL');
ck('C. автосекреты созданы (3 шт.)', __pc() >= 3, __pc());
ck('C. триггеров 4', ScriptApp.getProjectTriggers().length === 4, ScriptApp.getProjectTriggers().length);
setup();
ck('C. повторный setup без ошибок', true);
var ss2 = SpreadsheetApp.create('Broken');
var fx2 = ss2.insertSheet('FX_and_Settings');
fx2.getRange('A1:B1').setValues([['Rate','Value']]);
fx2.getRange('A7:B7').setValues([['Key','Value']]);
setup();
ck('C. полусобранный: достроен', !!ss2.getSheetByName('Ops_Log') && !!ss2.getSheetByName('Debt_Engine'), ss2.getSheets().length + ' листов');
var rep = repairSettings();
ck('C. repairSettings добавил 13 ключей', /13/.test(String(rep)), String(rep));
DebtEngine.replayAll();
var wf = CashflowEngine.computeWaterfall({});
ck('C. waterfall считается', wf.incomeUSD > 0, Math.round(wf.incomeUSD));
var debts = DebtEngine.getDebts();
ck('C. два долга', debts.length === 2 && debts[0].balance > 1000000, Math.round(debts[0].balance));
var an = AnomalyEngine.run();
ck('C. AnomalyEngine работает', Array.isArray(an), 'нашёл: ' + an.length);
securityAudit();
ck('C. securityAudit не падает', true);
var rep2 = repairSettings();
ck('C. repairSettings повторно: 0 новых', /: 0/.test(String(rep2)), String(rep2));
`;
let vmErr = null;
try { vm.runInContext(src + testC, sb); } catch (e) { vmErr = e; }

const C = sb.__C || { log: [], pass: 0, fail: 0 };
if (vmErr) { C.log.push('FAIL  часть C: ' + vmErr.message + ' | ' + String(vmErr.stack).split('\n').slice(0, 4).join(' ⏎ ')); C.fail++; }
C.log.forEach((l) => console.log(l));
pass += C.pass; fail += C.fail;

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
