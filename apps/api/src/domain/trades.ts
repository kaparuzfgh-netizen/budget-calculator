/**
 * trades.ts — журнал покупок/продаж позиции (T3d1). Чистые функции, без I/O.
 * Прибыль при продаже — по СРЕДНЕЙ цене: cost = q × invested / quantity.
 * Комиссия внутри суммы сделки. Количества и суммы — канонические десятичные
 * строки (domain/decimal.ts), в валюте позиции; никакого float.
 */
import { DomainError } from './errors';
import { addDec, compareDecStr, divDec, mulDec, mulDivDec, mulToMinor, subDec } from './decimal';
import type { HoldingKind } from './portfolio';

export const TRADE_KINDS: readonly HoldingKind[] = ['crypto', 'stock', 'bond'];
export const MAX_TRADES_PER_HOLDING = 200;

export interface TradeLike {
  id: number;
  side: 'buy' | 'sell';
  quantity: string;
  amount: string;
  traded_on: string;
  is_initial: boolean;
}

export interface PositionState {
  quantity: string | null;
  invested: string | null;
  realizedMinor: number | null;
  closedOn: string | null;
}

export const EMPTY_STATE: PositionState = { quantity: null, invested: null, realizedMinor: null, closedOn: null };

/** Начальная запись — первой, затем по дате, затем по id. */
export function sortTrades<T extends Pick<TradeLike, 'id' | 'traded_on' | 'is_initial'>>(ts: readonly T[]): T[] {
  return [...ts].sort((a, b) => {
    if (a.is_initial !== b.is_initial) return a.is_initial ? -1 : 1;
    if (a.traded_on !== b.traded_on) return a.traded_on < b.traded_on ? -1 : 1;
    return a.id - b.id;
  });
}

export function applyTrade(
  state: PositionState,
  t: Pick<TradeLike, 'side' | 'quantity' | 'amount' | 'traded_on'>,
): { state: PositionState; realizedMinor: number | null } {
  if (t.side === 'buy') {
    const quantity = state.quantity === null ? t.quantity : addDec(state.quantity, t.quantity);
    const invested = state.invested === null ? t.amount : addDec(state.invested, t.amount);
    if (quantity === null || invested === null) throw new DomainError('TOO_LARGE', 'Слишком большое количество или сумма');
    return { state: { ...state, quantity, invested, closedOn: null }, realizedMinor: null };
  }
  // sell
  if (state.quantity === null || compareDecStr(t.quantity, state.quantity) > 0) {
    throw new DomainError('OVERSELL', `Нельзя продать больше, чем есть: ${state.quantity ?? '0'}`);
  }
  const full = t.quantity === state.quantity;
  const invested = state.invested ?? '0';
  const cost = full ? invested : (mulDivDec(invested, t.quantity, state.quantity) ?? '0');
  const costMinor = cost === '0' ? 0 : mulToMinor(cost, '1');
  const r = mulToMinor(t.amount, '1') - costMinor;
  const realizedMinor = (state.realizedMinor ?? 0) + r;
  const left = subDec(state.quantity, t.quantity);
  if (left === null) throw new DomainError('OVERSELL', `Нельзя продать больше, чем есть: ${state.quantity}`);
  if (left === '0') {
    return { state: { quantity: null, invested: null, realizedMinor, closedOn: t.traded_on }, realizedMinor: r };
  }
  const rest = subDec(invested, cost);
  return {
    state: { quantity: left, invested: rest === null || rest === '0' ? null : rest, realizedMinor, closedOn: null },
    realizedMinor: r,
  };
}

export function foldTrades(ts: readonly TradeLike[]): { state: PositionState; perTrade: Map<number, number | null> } {
  let state = EMPTY_STATE;
  const perTrade = new Map<number, number | null>();
  for (const t of sortTrades(ts)) {
    const res = applyTrade(state, t);
    state = res.state;
    perTrade.set(t.id, res.realizedMinor);
  }
  return { state, perTrade };
}

/** Начальная запись для позиции без журнала (правило 2.3); null — «потрачено» неизвестно. */
export function startingTrade(h: {
  quantity: string | null;
  invested: string | null;
  avg_price: string | null;
  opened_on: string | null;
  created_at: string;
}): Omit<TradeLike, 'id'> | null {
  if (!h.quantity) return null;
  const amount = h.invested ?? (h.avg_price ? mulDec(h.quantity, h.avg_price) : null);
  if (!amount) return null;
  return {
    side: 'buy',
    is_initial: true,
    quantity: h.quantity,
    amount,
    traded_on: h.opened_on ?? h.created_at.slice(0, 10),
  };
}

/** Средняя цена покупки оставшегося количества. */
export function avgCost(state: Pick<PositionState, 'quantity' | 'invested'>): string | null {
  if (!state.quantity || !state.invested) return null;
  return divDec(state.invested, state.quantity);
}

/** Цена за единицу сделки (для подписи). */
export function unitPrice(t: Pick<TradeLike, 'quantity' | 'amount'>): string | null {
  return divDec(t.amount, t.quantity);
}

export function tradeError(kind: string): void {
  if (!(TRADE_KINDS as readonly string[]).includes(kind)) {
    throw new DomainError('TRADES_UNSUPPORTED', 'Сделки доступны для крипты, акций и облигаций');
  }
}
