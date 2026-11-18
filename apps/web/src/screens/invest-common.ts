/**
 * invest-common.ts — чистая логика экрана «Инвестиции» (без Preact): виды,
 * сборка тела POST/PATCH и проверка целей. Количество и цены уходят на
 * сервер СТРОКАМИ (JSON-число потеряет 8-й знак), сумма вклада — числом.
 * Это учёт, а не инвестиционная рекомендация.
 */
import type { HoldingKind } from '../api';
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

export function formError(f: HoldingForm, supported: readonly string[] = []): string | null {
  if (!f.name.trim()) return 'Введите название';
  if (f.name.trim().length > LIMITS.maxName) return `Название — до ${LIMITS.maxName} символов`;
  const c = currencyError(f.currency);
  if (c) return c;
  if (f.ticker.trim() && !/^[A-Za-z0-9.-]{1,12}$/.test(f.ticker.trim())) return 'Тикер — латиница/цифры, до 12 знаков';
  if (usesQty(f.kind)) {
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
  opts: { clientId?: string; original?: HoldingForm; supported?: readonly string[] },
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
  if (usesQty(f.kind)) {
    body.quantity = normDec(f.quantity);
    body.invested = normDec(f.invested);
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
