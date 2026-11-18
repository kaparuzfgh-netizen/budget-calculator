/**
 * trades.ts — журнал покупок/продаж позиции (T3d1). Журнал — источник истины,
 * `holdings` — кэш свёртки (quantity/invested/realized_minor/closed_on), пишется
 * ТОЛЬКО через repo.commitTrades (CAS по trade_rev, один db.batch).
 * Ошибки — {status, body} как в tma/common.err. В логи ничего (правило 10).
 */
import type { HoldingRow, ScopedRepo, TradeRow } from '../db/repo';
import { DomainError } from '../domain/errors';
import { err } from '../tma/common';
import {
  MAX_TRADES_PER_HOLDING,
  TRADE_KINDS,
  applyTrade,
  avgCost,
  foldTrades,
  sortTrades,
  startingTrade,
  unitPrice,
  type PositionState,
  type TradeLike,
} from '../domain/trades';

export interface TradeInput {
  side: 'buy' | 'sell';
  quantity: string;
  amount: string;
  traded_on: string;
  note: string | null;
  client_id?: string;
}

export interface TradeHoldingView {
  id: number;
  currency: string;
  quantity: string | null;
  invested: string | null;
  avg_cost: string | null;
  realized_minor: number | null;
  closed_on: string | null;
}

export interface TradeItem {
  id: number;
  side: 'buy' | 'sell';
  quantity: string;
  amount: string;
  unit_price: string | null;
  traded_on: string;
  note: string | null;
  initial: boolean;
  realized_minor: number | null;
}

const holdingView = (h: Pick<HoldingRow, 'id' | 'currency'>, s: PositionState): TradeHoldingView => ({
  id: h.id,
  currency: h.currency,
  quantity: s.quantity,
  invested: s.invested,
  avg_cost: avgCost(s),
  realized_minor: s.realizedMinor,
  closed_on: s.closedOn,
});

const toLike = (t: TradeRow): TradeLike => ({
  id: t.id,
  side: t.side,
  quantity: t.quantity,
  amount: t.amount,
  traded_on: t.traded_on,
  is_initial: t.is_initial === 1,
});

const notFound = () => err('not_found', 'Не найдено', 404);
const conflict = () => err('conflict', 'Конфликт записи — повторите запрос', 409);

/** Доменные ошибки сделок → HTTP 409/400. */
function mapDomain(e: unknown): never {
  if (e instanceof DomainError && e.code === 'OVERSELL') throw err('oversell', e.message, 409);
  throw e;
}

export async function addTrade(
  repo: ScopedRepo,
  holdingId: number,
  input: TradeInput,
): Promise<{ id: number; duplicate?: true; holding?: TradeHoldingView }> {
  const h = await repo.getHolding(holdingId);
  if (!h) throw notFound();
  if (!(TRADE_KINDS as readonly string[]).includes(h.kind))
    throw err('trades_unsupported', 'Сделки доступны для крипты, акций и облигаций', 409);
  const key = input.client_id ? `tma:${input.client_id}` : null;
  const dupResult = async () => {
    const dup = key ? await repo.findTradeByKey(key) : null;
    if (!dup) throw conflict();
    return { id: dup.id, duplicate: true as const };
  };
  if (key && (await repo.findTradeByKey(key))) return dupResult();

  const cnt = await repo.countTrades(h.id);
  if (cnt >= MAX_TRADES_PER_HOLDING) throw err('limit', `Максимум ${MAX_TRADES_PER_HOLDING} сделок на позицию`, 409);

  const t = { side: input.side, quantity: input.quantity, amount: input.amount, traded_on: input.traded_on };
  const inserts: Parameters<ScopedRepo['commitTrades']>[2]['inserts'] = [];
  let state: PositionState;
  try {
    if (cnt === 0) {
      const init = startingTrade(h);
      if (!init) throw err('invested_required', 'Сначала укажите в позиции, сколько потратили', 409);
      inserts.push({ ...init, note: null, source_key: `init:${h.id}` });
      state = foldTrades([{ id: -1, ...init }, { id: 0, is_initial: false, ...t }]).state;
    } else {
      const last = await repo.lastTradeOn(h.id);
      if (last === null || input.traded_on >= last) {
        // инкремент от кэша позиции, журнал не читаем
        state = applyTrade(
          { quantity: h.quantity, invested: h.invested, realizedMinor: h.realized_minor, closedOn: h.closed_on },
          t,
        ).state;
      } else {
        const journal = (await repo.listTrades(h.id)).map(toLike);
        state = foldTrades([...journal, { id: Number.MAX_SAFE_INTEGER, is_initial: false, ...t }]).state;
      }
    }
  } catch (e) {
    mapDomain(e);
  }
  inserts.push({
    side: input.side,
    is_initial: false,
    quantity: input.quantity,
    amount: input.amount,
    traded_on: input.traded_on,
    note: input.note,
    source_key: key,
  });
  let res: { applied: boolean; insertedId: number | null };
  try {
    res = await repo.commitTrades(h.id, h.trade_rev, { inserts, deleteIds: [] }, state!);
  } catch {
    // нарушение UNIQUE (параллельная запись того же ключа) — batch откатился целиком
    return dupResult();
  }
  if (!res.applied || res.insertedId === null) return dupResult();
  return { id: res.insertedId, holding: holdingView(h, state!) };
}

export async function removeTrade(repo: ScopedRepo, holdingId: number, tradeId: number): Promise<{ holding: TradeHoldingView }> {
  const h = await repo.getHolding(holdingId);
  if (!h) throw notFound();
  const journal = await repo.listTrades(h.id);
  const target = journal.find((t) => t.id === tradeId);
  if (!target) throw notFound();
  if (target.is_initial === 1) throw err('initial_locked', 'Начальную запись нельзя удалить, пока есть другие сделки', 409);
  const remaining = journal.filter((t) => t.id !== tradeId);
  let state: PositionState;
  const deleteIds = [tradeId];
  try {
    if (remaining.length === 1 && remaining[0]!.is_initial === 1) {
      // осталась только начальная запись — позиция возвращается к ручному режиму
      const init = remaining[0]!;
      deleteIds.push(init.id);
      state = { quantity: init.quantity, invested: init.amount, realizedMinor: null, closedOn: null };
    } else {
      state = foldTrades(remaining.map(toLike)).state;
    }
  } catch (e) {
    mapDomain(e);
  }
  let res: { applied: boolean };
  try {
    res = await repo.commitTrades(h.id, h.trade_rev, { inserts: [], deleteIds }, state!);
  } catch {
    throw conflict();
  }
  if (!res.applied) throw conflict();
  return { holding: holdingView(h, state!) };
}

export async function tradesView(
  repo: ScopedRepo,
  holdingId: number,
): Promise<{ holding: TradeHoldingView; items: TradeItem[]; limit: number } | null> {
  const h = await repo.getHolding(holdingId);
  if (!h) return null;
  const rows = await repo.listTrades(h.id);
  let perTrade = new Map<number, number | null>();
  try {
    perTrade = foldTrades(rows.map(toLike)).perTrade;
  } catch {
    // битый журнал — отдаём без результатов по сделкам
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: TradeItem[] = sortTrades(rows.map(toLike)).map((t) => {
    const r = byId.get(t.id)!;
    return {
      id: t.id,
      side: t.side,
      quantity: t.quantity,
      amount: t.amount,
      unit_price: unitPrice(t),
      traded_on: t.traded_on,
      note: r.note,
      initial: t.is_initial,
      realized_minor: t.side === 'sell' ? (perTrade.get(t.id) ?? null) : null,
    };
  });
  const inv = h.invested ?? null;
  return {
    holding: holdingView(h, { quantity: h.quantity, invested: inv, realizedMinor: h.realized_minor, closedOn: h.closed_on }),
    items,
    limit: MAX_TRADES_PER_HOLDING,
  };
}
