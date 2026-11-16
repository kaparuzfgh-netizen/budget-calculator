/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { LoanRow, LoanEventRow } from './types';
import type { Ctx } from './ctx';

export function loansRepo({ db, userId, en }: Ctx) {
  return {
    /** Все займы: сначала открытые, внутри — по id. */
    listLoans() {
      return db
        .prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY closed_at IS NOT NULL, id')
        .bind(userId)
        .all<LoanRow>().then((r) => decRows('loans', r));
    },
    getLoan(id: number) {
      return db.prepare('SELECT * FROM loans WHERE id = ? AND user_id = ?').bind(id, userId).first<LoanRow>().then((r) => decRow('loans', r));
    },
    /**
     * Создание займа. source_key ('tma:<client_id>') — только REST Mini App
     * (см. addDebt): OR IGNORE + partial UNIQUE игнорирует NULL-ключи бота.
     */
    async addLoan(l: {
      counterparty: string;
      direction: 'owe' | 'owed';
      amount_minor: number;
      currency: string;
      due_on: string | null;
      note: string | null;
      source_key?: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO loans (user_id, counterparty, direction, amount_minor, currency, due_on, note, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, await en('loans', 'counterparty', l.counterparty), l.direction, await en('loans', 'amount_minor', l.amount_minor), l.currency, l.due_on, await en('loans', 'note', l.note), l.source_key ?? null)
        .run();
    },
    findLoanByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM loans WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<LoanRow>().then((r) => decRow('loans', r));
    },
    /** Открытые займы (closed_at IS NULL) — верхняя граница лимита (P2-2). */
    async countLoans(): Promise<number> {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM loans WHERE user_id = ? AND closed_at IS NULL')
        .bind(userId)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },
    /** Точечная правка займа — все WHERE id=? AND user_id=? (чужие id молча). */
    async patchLoan(id: number, patch: { due_on?: string | null; note?: string | null }) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of ['due_on', 'note'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('loans', k, patch[k]));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE loans SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    /** Закрыть вручную (остаток прощается). Уже закрытый — no-op (changes=0). */
    closeLoan(id: number) {
      return db
        .prepare(`UPDATE loans SET closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND closed_at IS NULL`)
        .bind(id, userId)
        .run();
    },
    /** Удаление займа с журналом (batch = одна транзакция). */
    deleteLoan(id: number) {
      return db.batch([
        db.prepare('DELETE FROM loan_events WHERE user_id = ? AND loan_id = ?').bind(userId, id),
        db.prepare('DELETE FROM loans WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
    },
    listLoanEvents(loanId: number) {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? AND loan_id = ? ORDER BY event_on, id')
        .bind(userId, loanId)
        .all<LoanEventRow>().then((r) => decRows('loan_events', r));
    },
    /** Все журналы возвратов разом — для plural-вью без N+1 (P2-2). */
    listLoanEventsAll() {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? ORDER BY loan_id, event_on, id')
        .bind(userId)
        .all<LoanEventRow>().then((r) => decRows('loan_events', r));
    },
    /** loan_id пишется только если заём принадлежит юзеру (EXISTS в INSERT). */
    async addLoanEvent(e: {
      loan_id: number;
      amount_minor: number;
      event_on: string;
      source: 'manual' | 'auto';
      source_key: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO loan_events (user_id, loan_id, kind, amount_minor, event_on, source, source_key)
           SELECT ?, ?, 'repay', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM loans WHERE id = ? AND user_id = ?)`,
        )
        .bind(userId, e.loan_id, await en('loan_events', 'amount_minor', e.amount_minor), e.event_on, e.source, e.source_key, e.loan_id, userId)
        .run();
    },
    getLoanEvent(id: number) {
      return db.prepare('SELECT * FROM loan_events WHERE id = ? AND user_id = ?').bind(id, userId).first<LoanEventRow>().then((r) => decRow('loan_events', r));
    },
    findLoanEventByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<LoanEventRow>().then((r) => decRow('loan_events', r));
    },
    /** Правка возврата — replay пересчитает остаток. Чужие id молча. */
    async updateLoanEvent(id: number, patch: { amount_minor?: number; event_on?: string }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'event_on'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('loan_events', k, patch[k]));
        }
      if (!sets.length) return Promise.resolve({ success: true, meta: { changes: 0 } } as D1Result);
      binds.push(id, userId);
      return db.prepare(`UPDATE loan_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    deleteLoanEvent(id: number) {
      return db.prepare('DELETE FROM loan_events WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },
  };
}
