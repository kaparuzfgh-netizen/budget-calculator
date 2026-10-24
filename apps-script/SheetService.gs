/**
 * SheetService.gs — слой данных Google Sheets + утилиты.
 * Единственная точка доступа к таблице для всех движков.
 */

/** Таблица: привязанная (container-bound) или по SHEET_ID из Script Properties. */
function ss_() {
  const byId = getProp_(PROP.SHEET_ID, '');
  if (byId) return SpreadsheetApp.openById(byId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Скрипт не привязан к таблице и SHEET_ID не задан');
  return active;
}

function sheet_(code) {
  const name = SHEETS[code];
  let sh = ss_().getSheetByName(name);
  if (!sh) sh = ss_().insertSheet(name);
  return sh;
}

/** Все данные листа начиная со строки startRow (1-based), без заголовков. */
function readRange_(code, startRow) {
  const sh = sheet_(code);
  const last = sh.getLastRow();
  if (last < startRow) return [];
  return sh.getRange(startRow, 1, last - startRow + 1, Math.max(1, sh.getLastColumn())).getValues();
}

function appendRow_(code, values) {
  sheet_(code).appendRow(values);
}

function clearSheet_(code) {
  const sh = sheet_(code);
  sh.clear();
  sh.getRange('A1:Z1000').clearNote();
}

// ─────────────────────────── FX ───────────────────────────

/** Живые курсы из FX_and_Settings (B2 EURUSD, B3 USDRUB, B4 USDKGS) с fallback.
 *  Флаг FALLBACK_USED = true, если хоть один курс не рассчитан (#N/A/пусто):
 *  значит GOOGLEFINANCE недоступен и все конвертации идут на резервные значения. */
function getFx_() {
  const sh = sheet_(SHEETS.FX_SETTINGS);
  const v = sh.getRange('B2:B4').getValues();
  let fbUsed = false;
  const num = function (x, fb) {
    if (typeof x === 'number' && isFinite(x) && x > 0.1) return x;
    fbUsed = true;
    return fb;
  };
  const out = {
    EURUSD: num(v[0][0], CONFIG.FX_FALLBACK.EURUSD),
    USDRUB: num(v[1][0], CONFIG.FX_FALLBACK.USDRUB),
    USDKGS: num(v[2][0], CONFIG.FX_FALLBACK.USDKGS),
  };
  out.FALLBACK_USED = fbUsed;
  return out;
}

/** Конвертация между EUR/USD/RUB/KGS через базу USD. */
function convert_(amount, from, to, fx) {
  const toUsd = {
    USD: (a) => a,
    EUR: (a) => a * fx.EURUSD,
    RUB: (a) => a / fx.USDRUB,
    KGS: (a) => a / fx.USDKGS,
  };
  const fromUsd = {
    USD: (a) => a,
    EUR: (a) => a / fx.EURUSD,
    RUB: (a) => a * fx.USDRUB,
    KGS: (a) => a * fx.USDKGS,
  };
  from = (from || 'USD').toUpperCase();
  to = (to || 'USD').toUpperCase();
  if (!toUsd[from] || !fromUsd[to]) throw new Error('Неизвестная валюта: ' + from + '/' + to);
  return fromUsd[to](toUsd[from](amount));
}

// ─────────────────────────── Settings ───────────────────────────

/** Таблица конфигурации на листе FX_and_Settings, начиная со строки 8 (A=key, B=value). */
function getSettings_() {
  const out = {};
  const values = readRange_(SHEETS.FX_SETTINGS, 8);
  values.forEach((r) => {
    if (r[0]) out[String(r[0]).trim()] = r[1];
  });
  return out;
}

function getSetting_(key, fallback) {
  const v = getSettings_()[key];
  return v === undefined || v === '' || v === null ? fallback : v;
}

function getSettingNum_(key, fallback) {
  const v = getSetting_(key, null);
  if (v === null) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function setSetting_(key, value) {
  const sh = sheet_(SHEETS.FX_SETTINGS);
  const last = Math.max(sh.getLastRow(), 8);
  const keys = sh.getRange(8, 1, last - 7, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sh.getRange(8 + i, 2).setValue(value);
      return;
    }
  }
  sh.getRange(last + 1, 1, 1, 2).setValues([[key, value]]);
}

// ─────────────────────────── Properties ───────────────────────────

function getProp_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

/** Диалоговое состояние пользователя (например, ждём недельные траты). */
function getBotState_() {
  try {
    return JSON.parse(PropertiesService.getUserProperties().getProperty('BOT_STATE') || '{}');
  } catch (e) {
    return {};
  }
}

function setBotState_(state) {
  PropertiesService.getUserProperties().setProperty('BOT_STATE', JSON.stringify(state || {}));
}

// ─────────────────────────── Dates ───────────────────────────

function tz_() {
  return ss_().getSpreadsheetTimeZone() || 'Asia/Bishkek';
}

function fmtISO_(d) {
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function fmtMonthKey_(d) {
  return Utilities.formatDate(d, tz_(), 'yyyy-MM');
}

function nowTz_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
}

/** Понедельник недели, содержащей d. */
function mondayOf_(d) {
  const dt = new Date(d.getTime());
  const shift = (dt.getDay() + 6) % 7; // Пн=0
  dt.setDate(dt.getDate() - shift);
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** Ключ недельного цикла: ISO-дата воскресенья, открывшего цикл.
 *  Опрос уходит в вс 20:00; ответы с вс по сб (включая пн-надж)
 *  относятся к этому воскресенью — так ключи вопроса и ответа совпадают. */
function weekKey_(d) {
  const dt = new Date((d || new Date()).getTime());
  dt.setDate(dt.getDate() - dt.getDay()); // откат к воскресенью (getDay: вс=0)
  return fmtISO_(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()));
}

/** ISO-номер недели. */
function isoWeek_(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
}

/** Сколько дней осталось до конца месяца (включая сегодняшний). */
function daysLeftInMonth_() {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return daysInMonth - now.getDate() + 1;
}

// ─────────────────────────── Format & parse ───────────────────────────

function fmtMoney_(n, cur) {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Number(n) || 0);
  const fixed = (abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2)).replace('.', ',');
  const grouped = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sym = { USD: '$', EUR: '€', RUB: '₽', KGS: 'с' }[(cur || 'USD').toUpperCase()] || '';
  return sign + grouped + (sym ? ' ' + sym : '');
}

function fmtPct_(x, digits) {
  return (100 * (Number(x) || 0)).toFixed(digits === undefined ? 1 : digits) + '%';
}

/** "5 000,50" | "5000.5" | "5000" → число; null если не число. */
function parseAmount_(text) {
  const s = String(text).replace(/\s|\u00A0/g, '').replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Определяет валюту в тексте: EUR/€, RUB/₽/руб, KGS/с/сом, USD/$. */
function detectCurrency_(text, fallback) {
  const s = (text || '').toLowerCase();
  if (/(eur|€|евро)/.test(s)) return 'EUR';
  if (/(rub|₽|руб)/.test(s)) return 'RUB';
  if (/(kgs|сом|кгс)/.test(s)) return 'KGS';
  if (/(usd|\$|долл)/.test(s)) return 'USD';
  return fallback || 'RUB';
}

/**
 * Защита от formula-injection: пользовательский текст, попадающий в ячейки,
 * не должен начинаться с = + - @ (иначе Sheets выполнит его как формулу).
 */
function safeCellText_(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// ─────────────────────────── Lock ───────────────────────────

/** Сериализация конкурентных записей (webhook + триггеры). */
function runWithLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Сервер занят, повторите через минуту');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
