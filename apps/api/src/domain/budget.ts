/**
 * budget.ts — недельный/месячный бюджет (порт CashflowEngine.weeklyStatus).
 * Траты уже в валюте бюджета; `today` — ISO 'YYYY-MM-DD' параметром.
 */
import { num } from './errors';
import { dayOfMonth, daysInMonth, daysLeftInMonth, isoWeek } from './dates';

export interface ExpenseEntry {
  date: string; // 'YYYY-MM-DD'
  amount: number;
}

export interface WeeklyStatusInput {
  expenses: ExpenseEntry[];
  today: string;
  monthlyCap: number;
  weeklyBudget: number;
}

export interface WeeklyStatus {
  weekSpent: number;
  weekBudget: number;
  weekOver: boolean;
  weekRemaining: number;
  monthSpent: number;
  monthCap: number;
  monthRemaining: number;
  burnRate: number; // >1 — тратим быстрее плана
  dailyAllowance: number;
  daysLeft: number;
}

export function weeklyStatus(input: WeeklyStatusInput): WeeklyStatus {
  num(input.monthlyCap, 'monthlyCap', { nonNegative: true });
  num(input.weeklyBudget, 'weeklyBudget', { nonNegative: true });
  const cur = isoWeek(input.today);
  const curMonth = input.today.slice(0, 7);
  let weekSpent = 0;
  let monthSpent = 0;
  for (const e of input.expenses) {
    num(e.amount, 'expense.amount');
    // ISO-неделя с ISO-годом (legacy сравнивал календарный год — баг на границе года)
    const w = isoWeek(e.date);
    if (w.year === cur.year && w.week === cur.week) weekSpent += e.amount;
    if (e.date.slice(0, 7) === curMonth) monthSpent += e.amount;
  }
  const dim = daysInMonth(input.today);
  const daysLeft = daysLeftInMonth(input.today);
  return {
    weekSpent,
    weekBudget: input.weeklyBudget,
    weekOver: weekSpent > input.weeklyBudget,
    weekRemaining: input.weeklyBudget - weekSpent,
    monthSpent,
    monthCap: input.monthlyCap,
    monthRemaining: input.monthlyCap - monthSpent,
    burnRate: monthSpent / Math.max(1, dayOfMonth(input.today)) / (input.monthlyCap / dim),
    dailyAllowance: Math.max(0, input.monthlyCap - monthSpent) / daysLeft,
    daysLeft,
  };
}

/**
 * Защита от миспарса суммы (месячная аналитика как неделя, лишний ноль).
 * Замена legacy-порога «1 000 000 ₽» — лимит передаётся вызывающим кодом.
 */
export function looksUnrealisticWeeklyAmount(amountInBudgetCurrency: number, limit: number): boolean {
  num(amountInBudgetCurrency, 'amount');
  num(limit, 'limit', { positive: true });
  return amountInBudgetCurrency > limit;
}
