/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { IncomeEntryRow } from './types';
import type { Ctx } from './ctx';

export function incomeRepo({ db, userId, en }: Ctx) {
  return {
    async addIncomeEntry(e: {
      month: string;
      amount_minor: number;
      currency: string;
      note: string | null;
      source_key: string;
      received_on?: string | null;
    }) {
      return db
        .prepare(
          'INSERT OR IGNORE INTO income_entries (user_id, month, amount_minor, currency, note, source_key, received_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(userId, e.month, await en('income_entries', 'amount_minor', e.amount_minor), e.currency, await en('income_entries', 'note', e.note), e.source_key, e.received_on ?? null)
        .run();
    },
    listIncomeEntries(month: string) {
      return db
        .prepare('SELECT * FROM income_entries WHERE user_id = ? AND month = ? ORDER BY id')
        .bind(userId, month)
        .all<IncomeEntryRow>().then((r) => decRows('income_entries', r));
    },
    getIncomeEntry(id: number) {
      return db
        .prepare('SELECT * FROM income_entries WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<IncomeEntryRow>().then((r) => decRow('income_entries', r));
    },
    /** Правка записи дохода — только своей (чужие id молча). month — derived от received_on. */
    async patchIncomeEntry(id: number, patch: { received_on?: string; month?: string; note?: string | null }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['received_on', 'month', 'note'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('income_entries', k, patch[k]));
        }
      if (!sets.length) return db.prepare('SELECT 1').run();
      return db
        .prepare(`UPDATE income_entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds, id, userId)
        .run();
    },
    deleteIncomeEntry(id: number) {
      return db.prepare('DELETE FROM income_entries WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },
    findIncomeByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM income_entries WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<IncomeEntryRow>().then((r) => decRow('income_entries', r));
    },
  };
}
