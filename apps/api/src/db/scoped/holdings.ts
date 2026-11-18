/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { HoldingRow } from './types';
import type { Ctx } from './ctx';

/** Поля позиции, доступные для создания/правки (id, user_id, source_key, метки времени — нет). */
export type HoldingInput = Omit<HoldingRow, 'id' | 'user_id' | 'source_key' | 'created_at' | 'updated_at' | 'auto_price' | 'invested' | 'realized_minor' | 'closed_on' | 'hidden' | 'trade_rev'> & {
  invested?: string | null;
  auto_price?: number;
  /** Скрыть закрытую позицию (PATCH); создание всегда с 0. */
  hidden?: number;
};

const PATCHABLE = [
  'kind',
  'name',
  'ticker',
  'currency',
  'quantity',
  'avg_price',
  'invested',
  'price',
  'price_on',
  'amount_minor',
  'rate',
  'opened_on',
  'matures_on',
  'note',
  'auto_price',
  'hidden',
] as const;

export function holdingsRepo({ db, userId, en }: Ctx) {
  return {
    /** Все позиции (≤50): порядок по id; сортировка по шифрованным полям — только в JS. */
    listHoldings() {
      return db
        .prepare('SELECT * FROM holdings WHERE user_id = ? ORDER BY id')
        .bind(userId)
        .all<HoldingRow>()
        .then((r) => decRows('holdings', r));
    },
    getHolding(id: number) {
      return db.prepare('SELECT * FROM holdings WHERE id = ? AND user_id = ?').bind(id, userId).first<HoldingRow>().then((r) => decRow('holdings', r));
    },
    /** Создание; source_key ('tma:<client_id>') — OR IGNORE + partial UNIQUE (идемпотентность). */
    async addHolding(h: HoldingInput & { source_key?: string | null }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO holdings (user_id, kind, name, ticker, currency, quantity, avg_price, invested, price, price_on,
             amount_minor, rate, opened_on, matures_on, note, auto_price, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          h.kind,
          await en('holdings', 'name', h.name),
          await en('holdings', 'ticker', h.ticker),
          h.currency,
          await en('holdings', 'quantity', h.quantity),
          await en('holdings', 'avg_price', h.avg_price),
          await en('holdings', 'invested', h.invested ?? null),
          await en('holdings', 'price', h.price),
          h.price_on,
          await en('holdings', 'amount_minor', h.amount_minor),
          await en('holdings', 'rate', h.rate),
          h.opened_on,
          h.matures_on,
          await en('holdings', 'note', h.note),
          h.auto_price ?? 1,
          h.source_key ?? null,
        )
        .run();
    },
    findHoldingByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM holdings WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<HoldingRow>().then((r) => decRow('holdings', r));
    },
    async countHoldings(): Promise<number> {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM holdings WHERE user_id = ?').bind(userId).first<{ n: number }>();
      return r?.n ?? 0;
    },
    /** Точечная правка — WHERE id=? AND user_id=? (чужие id молча: changes=0). */
    async patchHolding(id: number, patch: Partial<HoldingInput>) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of PATCHABLE)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('holdings', k, patch[k] as string | number | null));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE holdings SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    /** Позиция + её сделки одним batch (FK: сначала сделки). */
    async deleteHolding(id: number) {
      const res = await db.batch([
        db.prepare('DELETE FROM holding_trades WHERE holding_id = ? AND user_id = ?').bind(id, userId),
        db.prepare('DELETE FROM holdings WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
      return res[1]!;
    },
  };
}
