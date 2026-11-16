/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { DebtRow, DebtEventRow } from './types';
import type { Ctx } from './ctx';

export function debtsRepo({ db, userId, en }: Ctx) {
  return {
    listDebts(activeOnly = true) {
      return db
        .prepare(`SELECT * FROM debts WHERE user_id = ?${activeOnly ? ' AND active = 1' : ''} ORDER BY id`)
        .bind(userId)
        .all<DebtRow>().then((r) => decRows('debts', r));
    },
    /** Один долг — строго свой (WHERE id AND user_id). */
    getDebt(id: number) {
      return db.prepare('SELECT * FROM debts WHERE id = ? AND user_id = ?').bind(id, userId).first<DebtRow>().then((r) => decRow('debts', r));
    },
    /**
     * Создание долга. source_key ('tma:<client_id>') — только REST Mini App;
     * partial UNIQUE(user_id, source_key) молча игнорирует NULL-ключи бота.
     * INSERT OR IGNORE: при гонке повторный запрос даёт changes=0 —
     * вызывающий достаёт существующую строку через findDebtByKey.
     */
    async addDebt(d: {
      name: string;
      currency: string;
      rate: number;
      frequency: 'monthly' | 'biweekly';
      initial_balance_minor: number;
      initial_payment_minor: number;
      epoch: string;
      due_day: number | null;
      source_key?: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO debts (user_id, name, currency, rate, frequency,
            initial_balance_minor, initial_payment_minor, epoch, due_day, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          await en('debts', 'name', d.name),
          d.currency,
          await en('debts', 'rate', d.rate),
          d.frequency,
          await en('debts', 'initial_balance_minor', d.initial_balance_minor),
          await en('debts', 'initial_payment_minor', d.initial_payment_minor),
          d.epoch,
          d.due_day,
          d.source_key ?? null,
        )
        .run();
    },
    findDebtByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM debts WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<DebtRow>().then((r) => decRow('debts', r));
    },
    /** Активные долги — верхняя граница лимита (P2-2). */
    async countDebts(): Promise<number> {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM debts WHERE user_id = ? AND active = 1')
        .bind(userId)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },
    /** Точечные правки — все WHERE id=? AND user_id=? (чужие id молча игнорируются). */
    async patchDebt(
      id: number,
      patch: {
        name?: string;
        rate?: number;
        initial_payment_minor?: number;
        due_day?: number | null;
        active?: number;
      },
    ) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of ['name', 'rate', 'initial_payment_minor', 'due_day', 'active'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('debts', k, patch[k]));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE debts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    /** Удаление долга вместе с его журналом (batch = одна транзакция). */
    deleteDebt(id: number) {
      return db.batch([
        db.prepare('DELETE FROM debt_events WHERE user_id = ? AND debt_id = ?').bind(userId, id),
        db.prepare('DELETE FROM debts WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
    },
    /** Журнал долга в порядке replay (дата, затем порядок записи). */
    listDebtEvents(debtId: number) {
      return db
        .prepare('SELECT * FROM debt_events WHERE user_id = ? AND debt_id = ? ORDER BY event_on, id')
        .bind(userId, debtId)
        .all<DebtEventRow>().then((r) => decRows('debt_events', r));
    },
    /** Все журналы разом — для plural-вью без N+1 (P2-2). Порядок: по долгу, дальше replay. */
    listDebtEventsAll() {
      return db
        .prepare('SELECT * FROM debt_events WHERE user_id = ? ORDER BY debt_id, event_on, id')
        .bind(userId)
        .all<DebtEventRow>().then((r) => decRows('debt_events', r));
    },
    /** INSERT OR IGNORE — идемпотентность по (user_id, source_key);
     *  debt_id пишется только если долг принадлежит юзеру (EXISTS). */
    async addDebtEvent(e: {
      debt_id: number;
      kind: 'payment' | 'prepay' | 'reconcile';
      amount_minor: number;
      event_on: string;
      mode?: 'reduce_payment' | 'reduce_term' | null;
      source: 'manual' | 'auto';
      source_key: string;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO debt_events (user_id, debt_id, kind, amount_minor, event_on, mode, source, source_key)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM debts WHERE id = ? AND user_id = ?)`,
        )
        .bind(
          userId,
          e.debt_id,
          e.kind,
          await en('debt_events', 'amount_minor', e.amount_minor),
          e.event_on,
          e.mode ?? null,
          e.source,
          e.source_key,
          e.debt_id,
          userId,
        )
        .run();
    },
    findDebtEventByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM debt_events WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<DebtEventRow>().then((r) => decRow('debt_events', r));
    },
    getDebtEvent(id: number) {
      return db.prepare('SELECT * FROM debt_events WHERE id = ? AND user_id = ?').bind(id, userId).first<DebtEventRow>().then((r) => decRow('debt_events', r));
    },
    /** Точечная правка события — реplay пересчитает состояние. Чужие id молча. */
    async updateDebtEvent(
      id: number,
      patch: { amount_minor?: number; event_on?: string; mode?: 'reduce_payment' | 'reduce_term' | null },
    ) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'event_on', 'mode'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('debt_events', k, patch[k]));
        }
      if (!sets.length) return Promise.resolve({ success: true, meta: { changes: 0 } } as D1Result);
      binds.push(id, userId);
      return db.prepare(`UPDATE debt_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    deleteDebtEvent(id: number) {
      return db.prepare('DELETE FROM debt_events WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },
  };
}
