#!/usr/bin/env node
/**
 * smoke-test.js — быстрые проверки бэкенда без Google (запуск: node scripts/smoke-test.js).
 *
 * Что проверяет (зелёное ядро):
 *   1) BUNDLE.gs парсится как валидный JS (ловит битые правки);
 *   2) нет дубликатов top-level функций/констант (ловит конфликт имён при склейке);
 *   3) жёсткие диапазоны setValues согласованы с массивами (класс бага «13≠12»);
 *   4) чистая математика движков: аннуитет ±50 ₽, инверсия срока, парсеры.
 *
 * Примечание: полная эмуляция Apps Script (мок SpreadsheetApp) показала
 * особенность Node-vm — const-биндинги скрипта не видны через переопределённые
 * глобальные функции (в реальном GAS все .gs делят одну область, артефакта нет).
 * Поэтому GAS-часть проверяйте в реальном проекте: setup() → securityAudit().
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const bundlePath = path.join(root, 'apps-script', 'BUNDLE.gs');
const src = fs.readFileSync(bundlePath, 'utf8');

let pass = 0, fail = 0;
const ck = (n, c, d) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d !== undefined && d !== null ? '  [' + d + ']' : '')); };

// 1) синтаксис
try { new (vm.Script)(src); ck('BUNDLE.gs парсится', true); }
catch (e) { ck('BUNDLE.gs парсится', false, e.message); }

// 2) дубликаты top-level символов
const decl = new Map();
const reDecl = /^(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm;
let m;
while ((m = reDecl.exec(src))) {
  const name = m[1] || m[2];
  decl.set(name, (decl.get(name) || 0) + 1);
}
const dupes = [...decl.entries()].filter(([, n]) => n > 1);
ck('нет дубликатов top-level объявлений (' + decl.size + ' символов)', dupes.length === 0, dupes.map(([n, c]) => n + '×' + c).join(', ') || '—');

// 3) согласованность жёстких диапазонов с массивами в Setup-строителях
const setupSrc = fs.readFileSync(path.join(root, 'apps-script', 'Setup_Sheets.gs'), 'utf8');
const rangeChecks = [
  ['A2:B5 (курсы)', /getRange\('A2:B5'\)\.setValues\(\[([\s\S]*?)\]\);/, 4],
  ['A6:B10 (ЧДП-калькулятор)', /getRange\('A6:B10'\)\.setValues\(\[([\s\S]*?)\]\);/, 5],
  ['A13:B16 (арбитраж)', /getRange\('A13:B16'\)\.setValues\(\[([\s\S]*?)\]\);/, 4],
];
rangeChecks.forEach(([label, re, expected]) => {
  const mm = setupSrc.match(re);
  if (!mm) { ck('диапазон ' + label, false, 'фрагмент не найден'); return; }
  const count = (mm[1].match(/^[ \t]*\[/gm) || []).length || 1;
  ck('диапазон ' + label + ': строк ' + count, count === expected, count + ' ≠ ' + expected);
});
// динамический диапазон конфигурации — размер по массиву
ck('конфигурация: динамический getRange(8,1,rows.length,2)', /getRange\(8,\s*1,\s*rows\.length,\s*2\)/.test(setupSrc));

// 4) чистая математика движков (извлечение методов по имени, без зависимостей)
function extractMethod(name) {
  const re = new RegExp(name + '_: function[^{]*\\{[\\s\\S]*?\\n  \\},');
  const mm = src.match(re);
  if (!mm) throw new Error('метод ' + name + ' не найден в бандле');
  return mm[0].replace(name + '_: function', 'function').replace(/\n  \},$/, '\n  }');
}
const sandbox = { console, Math, Date, Number, String, JSON, isFinite, isNaN };
vm.createContext(sandbox);
try {
  const mathLib = 'globalThis.annuity = ' + extractMethod('annuityPayment') + ';\n' +
    'globalThis.derivePeriods = ' + extractMethod('derivePeriods') + ';\n';
  vm.runInContext(mathLib, sandbox);
  const annuity = sandbox.annuity, derivePeriods = sandbox.derivePeriods;
  const nSber = derivePeriods(1287312, 0.119, 12, 44282);
  ck('аннуитет Сбербанка = 44 282 ±5 ₽', Math.abs(annuity(1287312, 0.119, 12, nSber) - 44282) < 5, annuity(1287312, 0.119, 12, nSber).toFixed(0));
  ck('ЧДП 706к → платёж ~19 996 ±5 ₽', Math.abs(annuity(1287312 - 706000, 0.119, 12, nSber) - 19996) < 5, annuity(1287312 - 706000, 0.119, 12, nSber).toFixed(0));
  ck('инверсия срока: n ≈ 34.5', Math.abs(derivePeriods(1287312, 0.119, 12, 44282) - 34.5) < 0.1, derivePeriods(1287312, 0.119, 12, 44282).toFixed(2));
  ck('Т-Банк: аннуитет по выведенному n', Math.abs(annuity(1491303, 0.0859, 26, derivePeriods(1491303, 0.0859, 26, 17314)) - 17314) < 5);
} catch (e) {
  ck('математика движков', false, e.message);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
