/** Часть scoped-репозитория (см. db/scoped/index.ts) — журнал сделок позиции (T3d1). Каждый запрос с WHERE user_id = ?. */
import { decRows } from '../crypto';
import type { TradeRow } from './types';
import type { Ctx } from './ctx';

/** Строка для вставки сделки (идёт только через commitTrades). */
export interface TradeInsert {
  side: 'buy' | 'sell';
  is_initial: boolean;
  quantity: string;
  amount: string;
  traded_on: string;
  note: string | null;
  source_key: string | null;
}

/** Новое состояние позиции — кэш свёртки журнала. */
export interface CommitState {
  quantity: string | null;
  invested: string | null;
  realizedMinor: number | null;
  closedOn: string | null;
}

export function tradesRepo({ db, userId, en }: Ctx) {
  const OWN = 'EXISTS (SELECT 1 FROM holdings WHERE id = ? AND user_id = ? AND trade_rev = ?)';
  return {
    /** Все сделки позиции (≤200), порядок — в JS (поля шифрованы). */
    async listTrades(holdingId: number): Promise<TradeRow[]> {
      const r = await db
        .prepare('SELECT * FROM holding_trades WHERE user_id = ? AND holding_id = ? ORDER BY id')
        .bind(userId, holdingId)
        .all<TradeRow>()
        .then((x) => decRows('holding_trades', x));
      return r.results;
    },
    async countTrades(holdingId: number): Promise<number> {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM holding_trades WHERE user_id = ? AND holding_id = ?').bind(userId, holdingId).first<{ n: number }>();
      return r?.n ?? 0;
    },
    /** holding_id → число сделок (без начальных записей не отличаем: начальная живёт только вместе с реальной). */
    async countTradesByHolding(): Promise<Map<number, number>> {
      const r = await db
        .prepare('SELECT holding_id, COUNT(*) AS n FROM holding_trades WHERE user_id = ? GROUP BY holding_id')
        .bind(userId)
        .all<{ holding_id: number; n: number }>();
      return new Map(r.results.map((x) => [x.holding_id, x.n]));
    },
    async lastTradeOn(holdingId: number): Promise<string | null> {
      const r = await db
        .prepare('SELECT MAX(traded_on) AS d FROM holding_trades WHERE user_id = ? AND holding_id = ? AND is_initial = 0')
        .bind(userId, holdingId)
        .first<{ d: string | null }>();
      return r?.d ?? null;
    },
    async findTradeByKey(key: string): Promise<TradeRow | null> {
      const r = await db.prepare('SELECT * FROM holding_trades WHERE user_id = ? AND source_key = ?').bind(userId, key).all<TradeRow>().then((x) => decRows('holding_trades', x));
      return r.results[0] ?? null;
    },
    /**
     * Атомарная запись (CAS по trade_rev, один db.batch): вставки/удаления сделок + кэш в holdings.
     * Применилось ⇔ UPDATE holdings затронул 1 строку. Чужой holding_id → 0 строк (EXISTS с user_id).
     */
    async commitTrades(
      holdingId: number,
      rev: number,
      ops: { inserts: TradeInsert[]; deleteIds: number[] },
      state: CommitState,
    ): Promise<{ applied: boolean; insertedId: number | null }> {
      const stmts: D1PreparedStatement[] = [];
      const insertIdx: number[] = [];
      for (const t of ops.inserts) {
        insertIdx.push(stmts.length);
        stmts.push(
          db
            .prepare(
              `INSERT INTO holding_trades (user_id, holding_id, side, is_initial, quantity, amount, traded_on, note, source_key)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${OWN}`,
            )
            .bind(
              userId,
              holdingId,
              t.side,
              t.is_initial ? 1 : 0,
              await en('holding_trades', 'quantity', t.quantity),
              await en('holding_trades', 'amount', t.amount),
              t.traded_on,
              await en('holding_trades', 'note', t.note),
              t.source_key,
              holdingId,
              userId,
              rev,
            ),
        );
      }
      for (const id of ops.deleteIds) {
        stmts.push(
          db
            .prepare(`DELETE FROM holding_trades WHERE id = ? AND user_id = ? AND holding_id = ? AND ${OWN}`)
            .bind(id, userId, holdingId, holdingId, userId, rev),
        );
      }
      stmts.push(
        db
          .prepare(
            `UPDATE holdings SET quantity = ?, invested = ?, realized_minor = ?, closed_on = ?,
               hidden = CASE WHEN ? IS NULL THEN 0 ELSE hidden END, trade_rev = trade_rev + 1, updated_at = datetime('now')
             WHERE id = ? AND user_id = ? AND trade_rev = ?`,
          )
          .bind(
            await en('holdings', 'quantity', state.quantity),
            await en('holdings', 'invested', state.invested),
            await en('holdings', 'realized_minor', state.realizedMinor),
            state.closedOn,
            state.closedOn,
            holdingId,
            userId,
            rev,
          ),
      );
      const res = await db.batch(stmts);
      const applied = (res[res.length - 1]?.meta?.changes ?? 0) === 1;
      const lastIns = insertIdx.length ? res[insertIdx[insertIdx.length - 1]!] : null;
      return { applied, insertedId: applied && lastIns ? (lastIns.meta?.last_row_id ?? null) : null };
    },
  };
}
