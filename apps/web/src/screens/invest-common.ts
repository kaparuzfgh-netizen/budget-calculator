/**
 * invest-common.ts — чистая логика экрана «Инвестиции» (без Preact): виды,
 * сборка тела POST/PATCH и проверка целей. Количество и цены уходят на
 * сервер СТРОКАМИ (JSON-число потеряет 8-й знак), сумма вклада — числом.
 * Это учёт, а не инвестиционная рекомендация.
 */
import type { HoldingItem, HoldingKind } from '../api';
import { amountError, currencyError, LIMITS, parseAmount } from '../fmt';

export const KINDS: readonly HoldingKind[] = ['deposit', 'bond', 'crypto', 'stock', 'other'];
export const KIND_LABEL: Record<HoldingKind, string> = {
  deposit: 'Вклад',
  bond: 'Облигации',
  crypto: 'Крипта',
  stock: 'Акции',
  other: 'Другое',
};
export const KIND_PLURAL: Record<HoldingKind, string> = {
  deposit: 'Вклады',
  bond: 'Облигации',
  crypto: 'Крипта',
  stock: 'Акции',
  other: 'Другое',
};
/** Модель оценки зависит от вида: qty×price либо одна сумма. */
export const usesQty = (k: HoldingKind): boolean => k === 'crypto' || k === 'stock' || k === 'bond';
export const usesRate = (k: HoldingKind): boolean => k === 'deposit' || k === 'bond';

const DEC_RE = /^\d{1,12}([.,]\d{1,8})?$/;
/** «0,5» → «0.5»; пусто/мусор/ноль → null. */
export function normDec(raw: string): string | null {
  const t = raw.trim();
  if (!DEC_RE.test(t)) return null;
  const s = t.replace(',', '.');
  return Number(s) > 0 ? s : null;
}
const decError = (raw: string, what: string): string | null =>
  normDec(raw) === null ? `${what}: число больше нуля, до 8 знаков после запятой` : null;

export interface HoldingForm {
  kind: HoldingKind;
  name: string;
  ticker: string;
  currency: string;
  quantity: string;
  /** «Потрачено всего» — сколько заплатили за всё количество. */
  invested: string;
  price: string;
  amount: string;
  rate: string;
  openedOn: string;
  maturesOn: string;
  note: string;
}
export const emptyForm = (kind: HoldingKind = 'deposit'): HoldingForm => ({
  kind, name: '', ticker: '', currency: '', quantity: '', invested: '', price: '', amount: '', rate: '',
  openedOn: '', maturesOn: '', note: '',
});

const SECID_RE = /^[A-Za-z0-9-]{1,12}$/;
/** У позиции есть автоцена: крипта из белого списка сервера либо акция/облигация с кодом Мосбиржи. */
export const autoSupported = (kind: HoldingKind, ticker: string, supported: readonly string[]): boolean =>
  kind === 'crypto'
    ? supported.includes(ticker.trim().toUpperCase())
    : (kind === 'stock' || kind === 'bond') && SECID_RE.test(ticker.trim());

/** Поле «Цена сейчас» нужно, только если автоцены у позиции нет. */
export const needsPrice = (f: Pick<HoldingForm, 'kind' | 'ticker'>, supported: readonly string[]): boolean =>
  usesQty(f.kind) && !autoSupported(f.kind, f.ticker, supported);

/** «ЧЧ:ММ» локального времени авто-котировки (ISO) или пусто. */
export function fmtAutoTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formError(f: HoldingForm, supported: readonly string[] = [], closed = false): string | null {
  if (!f.name.trim()) return 'Введите название';
  if (f.name.trim().length > LIMITS.maxName) return `Название — до ${LIMITS.maxName} символов`;
  const c = currencyError(f.currency);
  if (c) return c;
  if (f.ticker.trim() && !/^[A-Za-z0-9.-]{1,12}$/.test(f.ticker.trim())) return 'Тикер — латиница/цифры, до 12 знаков';
  if (closed) {
    // закрытая позиция: количества нет, правятся только название, тикер и заметка
  } else if (usesQty(f.kind)) {
    const e =
      decError(f.quantity, 'Количество') ??
      decError(f.invested, 'Потрачено') ??
      (needsPrice(f, supported) ? decError(f.price, 'Цена сейчас') : null);
    if (e) return e;
  } else {
    const e = amountError(f.amount);
    if (e) return e;
  }
  if (f.rate.trim()) {
    const r = parseAmount(f.rate);
    if (r === null || r < 0 || r > 100) return 'Ставка — число от 0 до 100';
  }
  if (f.openedOn && f.maturesOn && f.maturesOn < f.openedOn) return 'Окончание раньше открытия';
  return null;
}

/**
 * Тело запроса. create: kind + client_id; edit: без kind/client_id, цена
 * уходит только если изменилась (сервер при новой цене ставит «цена на сегодня»).
 */
export function buildBody(
  f: HoldingForm,
  opts: { clientId?: string; original?: HoldingForm; supported?: readonly string[]; locked?: boolean },
): Record<string, unknown> {
  const o = opts.original;
  const body: Record<string, unknown> = {
    name: f.name.trim(),
    ticker: f.ticker.trim() ? f.ticker.trim().toUpperCase() : null,
    currency: f.currency.trim().toUpperCase(),
    note: f.note.trim() || null,
    opened_on: f.openedOn || null,
    matures_on: f.maturesOn || null,
    rate: usesRate(f.kind) && f.rate.trim() ? parseAmount(f.rate) : null,
  };
  if (opts.locked) delete body.currency; // есть сделки: валюта, количество и «потрачено» меняются только сделками
  if (usesQty(f.kind)) {
    if (!opts.locked) {
      body.quantity = normDec(f.quantity);
      body.invested = normDec(f.invested);
    }
    if (needsPrice(f, opts.supported ?? []) && (!o || normDec(o.price) !== normDec(f.price))) body.price = normDec(f.price);
  } else {
    body.amount = parseAmount(f.amount);
  }
  if (!o) {
    body.kind = f.kind;
    if (opts.clientId) body.client_id = opts.clientId;
  }
  return body;
}

/** Цели: пустые поля = 0; целые 0..100, сумма ровно 100. */
export function targetsFrom(draft: Partial<Record<HoldingKind, string>>): { error: string } | { targets: Record<string, number> } {
  const t: Record<string, number> = {};
  let sum = 0;
  for (const k of KINDS) {
    const raw = (draft[k] ?? '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100) return { error: 'Доля — целое число от 0 до 100' };
    if (n > 0) t[k] = n;
    sum += n;
  }
  if (sum !== 100) return { error: `Сумма долей должна быть 100% (сейчас ${sum}%)` };
  return { targets: t };
}

// ── журнал сделок (T3d1) ──

/** Есть журнал: количество, «потрачено» и валюта правятся только сделками. */
export const isLocked = (h: Pick<HoldingItem, 'trades_count'> | null | undefined): boolean => !!h && h.trades_count > 0;

/** Сравнение десятичных строк без Number (BigInt, 8 знаков): -1 | 0 | 1. Мусор → NaN-подобно 1. */
export function cmpDec(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): bigint | null => {
    const m = /^(\d{1,12})(?:[.,](\d{1,8}))?$/.exec(s.trim());
    return m ? BigInt(m[1]! + (m[2] ?? '').padEnd(8, '0')) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface TradeForm {
  side: 'buy' | 'sell';
  quantity: string;
  amount: string;
  tradedOn: string;
  note: string;
}

/** Проверка формы сделки; have — сколько сейчас есть (для продажи). */
export function tradeFormError(f: TradeForm, have: string | null, today?: string): string | null {
  if (normDec(f.quantity) === null) return 'Количество: число больше нуля, до 8 знаков после запятой';
  if (normDec(f.amount) === null) return 'Сумма: число больше нуля, до 8 знаков после запятой';
  if (f.tradedOn && today && f.tradedOn > today) return 'Дата не может быть в будущем';
  if (f.side === 'sell') {
    if (have === null || cmpDec(normDec(f.quantity)!, have) > 0) return `Нельзя продать больше, чем есть: ${have ?? '0'}`;
  }
  return null;
}

/** Тело POST сделки: количество и сумма — СТРОКАМИ; client_id — на попытку. */
export function buildTradeBody(f: TradeForm, clientId: string): Record<string, unknown> {
  return {
    side: f.side,
    quantity: normDec(f.quantity),
    amount: normDec(f.amount),
    ...(f.tradedOn ? { traded_on: f.tradedOn } : {}),
    note: f.note.trim() || null,
    client_id: clientId,
  };
}

/** Открытые / закрытые видимые / скрытые закрытые. */
export function splitPositions(items: HoldingItem[]): { open: HoldingItem[]; closed: HoldingItem[]; hidden: HoldingItem[] } {
  const open: HoldingItem[] = [];
  const closed: HoldingItem[] = [];
  const hidden: HoldingItem[] = [];
  for (const h of items) {
    if (!h.closed_on) open.push(h);
    else if (h.hidden) hidden.push(h);
    else closed.push(h);
  }
  return { open, closed, hidden };
}
