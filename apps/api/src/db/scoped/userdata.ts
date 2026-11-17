/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRows } from '../crypto';
import type { IncomeEntryRow, DebtEventRow, CommitmentPaymentRow, CommitmentChangeRow, LoanEventRow } from './types';
import type { Ctx } from './ctx';
import type { profileRepo } from './profile';
import type { commitmentsRepo } from './commitments';
import type { expensesRepo } from './expenses';
import type { debtsRepo } from './debts';
import type { loansRepo } from './loans';
import type { holdingsRepo } from './holdings';
import type { exchangesRepo } from './exchanges';
import type { categoriesRepo } from './categories';

/** Источники для экспорта: композиция остальных частей (без this между модулями). */
export type DataSources = ReturnType<typeof profileRepo> &
  ReturnType<typeof commitmentsRepo> &
  ReturnType<typeof expensesRepo> &
  ReturnType<typeof debtsRepo> &
  ReturnType<typeof loansRepo> &
  ReturnType<typeof holdingsRepo> &
  ReturnType<typeof exchangesRepo> &
  ReturnType<typeof categoriesRepo>;

export function userDataRepo({ db, userId }: Ctx, r: DataSources) {
  return {
    /** /export — только собственные строки пользователя, без секретов/хэшей. */
    async exportUserData() {
      const [profile, commitments, commitPays, commitChanges, expenses, income, debts, debtEvents, loans, loanEvents, exchanges, categories, holdings] =
        await Promise.all([
          r.getProfile(),
          r.listCommitments(false),
          db.prepare('SELECT * FROM commitment_payments WHERE user_id = ? ORDER BY id').bind(userId).all<CommitmentPaymentRow>().then((r) => decRows('commitment_payments', r)),
          db.prepare('SELECT * FROM commitment_changes WHERE user_id = ? ORDER BY id').bind(userId).all<CommitmentChangeRow>().then((r) => decRows('commitment_changes', r)),
          r.listExpenses(),
          db.prepare('SELECT * FROM income_entries WHERE user_id = ? ORDER BY id').bind(userId).all<IncomeEntryRow>().then((r) => decRows('income_entries', r)),
          r.listDebts(false),
          db.prepare('SELECT * FROM debt_events WHERE user_id = ? ORDER BY id').bind(userId).all<DebtEventRow>().then((r) => decRows('debt_events', r)),
          r.listLoans(),
          db.prepare('SELECT * FROM loan_events WHERE user_id = ? ORDER BY id').bind(userId).all<LoanEventRow>().then((r) => decRows('loan_events', r)),
          r.listExchanges(),
          r.listCategories(true),
          r.listHoldings(),
        ]);
      const strip = <T extends Record<string, unknown>>(r: T) => {
        const { source_key, ...rest } = r; // update_id-идемпотентность не экспортируем
        void source_key;
        return rest;
      };
      return {
        schema_version: 7,
        exported_at: new Date().toISOString(),
        profile: profile ? strip(profile as unknown as Record<string, unknown>) : null,
        commitments: commitments.results.map((c) => strip(c as unknown as Record<string, unknown>)),
        commitment_payments: commitPays.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        commitment_changes: commitChanges.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        weekly_expenses: expenses.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        income_entries: income.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        debts: debts.results.map((d) => strip(d as unknown as Record<string, unknown>)),
        debt_events: debtEvents.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        loans: loans.results.map((l) => strip(l as unknown as Record<string, unknown>)),
        loan_events: loanEvents.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        exchanges: exchanges.results.map((x) => strip(x as unknown as Record<string, unknown>)),
        categories: categories.results.map((x) => strip(x as unknown as Record<string, unknown>)),
        holdings: holdings.results.map((x) => strip(x as unknown as Record<string, unknown>)),
      };
    },
    /** /delete_me — все строки пользователя во всех таблицах с user_id (children first). */
    deleteAllUserData() {
      const tables = [
        'conversation_state',
        'income_entries',
        'weekly_expenses',
        'categories',
        'holdings',
        'loan_events',
        'loans',
        'exchanges',
        'debt_events',
        'debts',
        'commitment_changes',
        'commitment_payments',
        'commitments',
        'profiles',
        'consents',
        'reminder_log',
        'audit_log',
      ];
      const stmts = tables.map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId));
      stmts.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));
      return db.batch(stmts);
    },
  };
}
