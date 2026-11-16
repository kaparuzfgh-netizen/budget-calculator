/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { ExchangeRow } from './types';
import type { Ctx } from './ctx';

export function exchangesRepo({ db, userId, en }: Ctx) {
  return {
    /** Последние обмены (свежие первыми), верхняя граница — limit. */
    listExchanges(limit = 50) {
      return db
        .prepare('SELECT * FROM exchanges WHERE user_id = ? ORDER BY spent_on DESC, id DESC LIMIT ?')
        .bind(userId, limit)
        .all<ExchangeRow>().then((r) => decRows('exchanges', r));
    },
    getExchange(id: number) {
      return db.prepare('SELECT * FROM exchanges WHERE id = ? AND user_id = ?').bind(id, userId).first<ExchangeRow>().then((r) => decRow('exchanges', r));
    },
    /**
     * Запись обмена. rate считается здесь (to/from), INSERT OR IGNORE —
     * идемпотентность по partial UNIQUE (user_id, source_key); NULL-ключи
     * ручных повторных записей не конфликтуют (как debts/loans).
     */
    async addExchange(e: {
      from_ccy: string;
      to_ccy: string;
      amount_from_minor: number;
      amount_to_minor: number;
      market_rate: number | null;
      spent_on: string;
      note: string;
      source: string;
      source_key: string | null;
    }) {
      const rate = e.amount_to_minor / e.amount_from_minor;
      return db
        .prepare(
          `INSERT OR IGNORE INTO exchanges
            (user_id, from_ccy, to_ccy, amount_from_minor, amount_to_minor, rate, market_rate, spent_on, note, source, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          e.from_ccy,
          e.to_ccy,
          await en('exchanges', 'amount_from_minor', e.amount_from_minor),
          await en('exchanges', 'amount_to_minor', e.amount_to_minor),
          await en('exchanges', 'rate', rate),
          e.market_rate,
          e.spent_on,
          await en('exchanges', 'note', e.note),
          e.source,
          e.source_key,
        )
        .run();
    },
    findExchangeByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM exchanges WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<ExchangeRow>().then((r) => decRow('exchanges', r));
    },
    /**
     * Правка обмена — только своей записи (чужие id молча).
     * При смене любой суммы вызывающий ОБЯЗАН передать пересчитанный rate
     * (to/from по новым значениям) — инвариант держится на границе repo.
     */
    async patchExchange(
      id: number,
      patch: {
        amount_from_minor?: number;
        amount_to_minor?: number;
        rate?: number;
        spent_on?: string;
        note?: string;
        market_rate?: number | null;
      },
    ) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_from_minor', 'amount_to_minor', 'rate', 'spent_on', 'note', 'market_rate'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('exchanges', k, patch[k]));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE exchanges SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    deleteExchange(id: number) {
      return db.prepare('DELETE FROM exchanges WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },
  };
}
