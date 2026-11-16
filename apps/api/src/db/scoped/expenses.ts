/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { ExpenseRow } from './types';
import type { Ctx } from './ctx';

export function expensesRepo({ db, userId, en }: Ctx) {
  return {
    async addExpense(e: {
      spent_on: string;
      amount_minor: number;
      currency: string;
      note: string | null;
      source: string;
      source_key: string;
      category_id?: number | null;
    }) {
      // category_id пишется только если категория принадлежит юзеру (CASE+EXISTS).
      return db
        .prepare(
          `INSERT OR IGNORE INTO weekly_expenses (user_id, spent_on, amount_minor, currency, note, source, source_key, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL
             WHEN EXISTS(SELECT 1 FROM categories WHERE id=? AND user_id=?) THEN ? END)`,
        )
        .bind(userId, e.spent_on, await en('weekly_expenses', 'amount_minor', e.amount_minor), e.currency, await en('weekly_expenses', 'note', e.note), e.source, e.source_key, e.category_id ?? null, e.category_id ?? null, userId, e.category_id ?? null)
        .run();
    },
    findExpenseByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM weekly_expenses WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<ExpenseRow>().then((r) => decRow('weekly_expenses', r));
    },
    getExpense(id: number) {
      return db
        .prepare('SELECT * FROM weekly_expenses WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<ExpenseRow>().then((r) => decRow('weekly_expenses', r));
    },
    /** Правка траты — только своей записи. */
    async patchExpense(id: number, patch: { amount_minor?: number; currency?: string; note?: string | null; category_id?: number | null; spent_on?: string }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'currency', 'note', 'spent_on'] as const)
        if (k in patch) {
          sets.push(`${k} = ?`);
          binds.push(await en('weekly_expenses', k, patch[k]));
        }
      if (patch.category_id !== undefined) {
        // чужая категория не записывается никогда: ELSE — оставить как было
        sets.push(
          'category_id = CASE WHEN ? IS NULL THEN NULL WHEN EXISTS(SELECT 1 FROM categories WHERE id=? AND user_id=?) THEN ? ELSE category_id END',
        );
        binds.push(patch.category_id, patch.category_id, userId, patch.category_id);
      }
      if (!sets.length) return db.prepare('SELECT 1').run();
      return db
        .prepare(`UPDATE weekly_expenses SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds, id, userId)
        .run();
    },
    deleteExpense(id: number) {
      return db.prepare('DELETE FROM weekly_expenses WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },
    listExpenses(sinceIsoDate?: string) {
      return db
        .prepare(
          `SELECT * FROM weekly_expenses WHERE user_id = ?${sinceIsoDate ? ' AND spent_on >= ?' : ''} ORDER BY spent_on, id`,
        )
        .bind(...(sinceIsoDate ? [userId, sinceIsoDate] : [userId]))
        .all<ExpenseRow>().then((r) => decRows('weekly_expenses', r));
    },
  };
}
