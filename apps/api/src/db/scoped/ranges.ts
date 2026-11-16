/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRows } from '../crypto';
import type { ExpenseRow, IncomeEntryRow, DebtEventRow, CommitmentPaymentRow, LoanEventRow } from './types';
import type { Ctx } from './ctx';

export function rangesRepo({ db, userId }: Ctx) {
  return {
    listExpensesBetween(from: string, to: string) {
      return db
        .prepare('SELECT * FROM weekly_expenses WHERE user_id = ? AND spent_on BETWEEN ? AND ? ORDER BY spent_on, id')
        .bind(userId, from, to)
        .all<ExpenseRow>()
        .then((r) => decRows('weekly_expenses', r));
    },
    listCommitmentPaymentsBetween(from: string, to: string) {
      return db
        .prepare('SELECT * FROM commitment_payments WHERE user_id = ? AND paid_on BETWEEN ? AND ? ORDER BY paid_on, id')
        .bind(userId, from, to)
        .all<CommitmentPaymentRow>()
        .then((r) => decRows('commitment_payments', r));
    },
    /** События долгов: только платежи/ЧДП (reconcile в отчёт не идёт). */
    listDebtEventsBetween(from: string, to: string) {
      return db
        .prepare(
          "SELECT * FROM debt_events WHERE user_id = ? AND event_on BETWEEN ? AND ? AND kind IN ('payment','prepay') ORDER BY event_on, id",
        )
        .bind(userId, from, to)
        .all<DebtEventRow>()
        .then((r) => decRows('debt_events', r));
    },
    listLoanEventsBetween(from: string, to: string) {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? AND event_on BETWEEN ? AND ? ORDER BY event_on, id')
        .bind(userId, from, to)
        .all<LoanEventRow>()
        .then((r) => decRows('loan_events', r));
    },
    /** Доходы по фактической дате (received_on, fallback — 1-е число месяца). */
    listIncomeBetween(from: string, to: string) {
      return db
        .prepare(
          "SELECT * FROM income_entries WHERE user_id = ? AND COALESCE(received_on, month || '-01') BETWEEN ? AND ? ORDER BY id",
        )
        .bind(userId, from, to)
        .all<IncomeEntryRow>()
        .then((r) => decRows('income_entries', r));
    },
  };
}
