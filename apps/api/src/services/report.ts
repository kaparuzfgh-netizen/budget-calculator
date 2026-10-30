/**
 * report.ts — сборка пользовательского отчёта: repo-чтения по диапазону
 * (prev.from..cur.to одним заходом на поток) → чистый domain.buildReport.
 * Общий для TMA API и бота.
 */
import type { Currency } from '../domain/money';
import { convert } from '../domain/money';
import { buildReport, periodRange, type Period, type Report } from '../domain/report';
import { todayInTz } from '../bot/parse';
import type { scoped } from '../db/repo';

type Repo = ReturnType<typeof scoped>;
type FxGetter = (ccys: string[]) => Promise<{ perUsd: Record<string, number>; asOf: string }>;

export async function buildUserReport(
  repo: Repo,
  fxGet: FxGetter,
  period: Period,
  offset: number,
  now: Date,
  targetCcy?: string,
): Promise<Report | null> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) return null;
  const target = (targetCcy ?? p.income_currency) as Currency;
  const today = todayInTz(p.timezone, now);
  const range = periodRange(period, today, offset);
  const prevRange = periodRange(period, today, offset - 1);
  const from = prevRange.from;
  const to = range.to;

  const [expenses, commitPays, debtEvents, loanEvents, income, debts, loans, cats] = await Promise.all([
    repo.listExpensesBetween(from, to),
    repo.listCommitmentPaymentsBetween(from, to),
    repo.listDebtEventsBetween(from, to),
    repo.listLoanEventsBetween(from, to),
    repo.listIncomeBetween(from, to),
    repo.listDebts(false),
    repo.listLoans(),
    repo.listCategories(true),
  ]);

  const debtCcy = new Map(debts.results.map((d) => [d.id, d.currency]));
  const loanDir = new Map(loans.results.map((l) => [l.id, l.direction]));
  const loanCcy = new Map(loans.results.map((l) => [l.id, l.currency]));

  const ccys = new Set<string>([p.living_currency, target]);
  for (const e of expenses.results) ccys.add(e.currency);
  for (const e of commitPays.results) ccys.add(e.currency);
  for (const e of debtEvents.results) ccys.add(debtCcy.get(e.debt_id) ?? p.living_currency);
  for (const e of loanEvents.results) ccys.add(loanCcy.get(e.loan_id) ?? p.living_currency);
  for (const e of income.results) ccys.add(e.currency);
  const fxr = await fxGet([...ccys]);

  return buildReport({
    period,
    offset,
    range,
    prevRange,
    currency: target,
    perUsd: fxr.perUsd,
    fx_as_of: fxr.asOf,
    // норма хранится в living_currency — конвертируем в валюту отчёта
    livingCapMajor: convert(p.living_cap_minor / 100, p.living_currency, target, { perUsd: fxr.perUsd }),
    weeklyBudgetMajor: convert(p.weekly_budget_minor / 100, p.living_currency, target, { perUsd: fxr.perUsd }),
    categories: cats.results.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji })),
    expenses: expenses.results.map((e) => ({
      id: e.id,
      spent_on: e.spent_on,
      amount_minor: e.amount_minor,
      currency: e.currency,
      note: e.note,
      category_id: e.category_id,
    })),
    commitPays: commitPays.results.map((e) => ({ paid_on: e.paid_on, amount_minor: e.amount_minor, currency: e.currency })),
    debtEvents: debtEvents.results.map((e) => ({
      event_on: e.event_on,
      amount_minor: e.amount_minor,
      currency: debtCcy.get(e.debt_id) ?? p.living_currency,
      kind: e.kind,
    })),
    loanEvents: loanEvents.results.map((e) => ({
      event_on: e.event_on,
      amount_minor: e.amount_minor,
      currency: loanCcy.get(e.loan_id) ?? p.living_currency,
      direction: loanDir.get(e.loan_id) ?? 'owe',
    })),
    income: income.results.map((e) => ({
      received_on: e.received_on ?? `${e.month}-01`,
      amount_minor: e.amount_minor,
      currency: e.currency,
    })),
  });
}
