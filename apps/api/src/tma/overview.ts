/**
 * tma/overview.ts — GET /api/tma/overview (шаг 5).
 * Собирает «Обзор» для Mini App ТОЛЬКО через scoped-repo вызывающего
 * пользователя (tenant-scoped, S5). Доменная математика переиспользуется,
 * не дублируется: resolveIncome (features.ts) и weeklyStatus (domain/budget).
 * Деньги на границе — INTEGER minor units (как в D1).
 */
import { weeklyStatus } from '../domain/budget';
import { convert, round2 } from '../domain/money';
import type { FxResult } from '../fx/service';
import type { ScopedRepo } from '../db/repo';
import { resolveIncome } from '../bot/features';
import { baselineIncome } from '../services/baseline';
import { monthInTz, todayInTz, weekStartInTz } from '../bot/parse';

export interface OverviewCommitment {
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
}

export interface Overview {
  month: string; // 'YYYY-MM' в таймзоне пользователя
  base_currency: string;
  /** Доход месяца: факт записей → базовый (явный/расчётный) → 0 (income_month_source). */
  income_month_minor: number;
  income_month_currency: string;
  income_month_source: 'actual' | 'typical' | 'computed' | 'none';
  income_entries_count: number;
  /** Активные регулярные платежи (в исходных валютах). */
  commitments: OverviewCommitment[];
  /** Повседневные: недельный бюджет и факт трат (living_currency). */
  weekly_budget_minor: number;
  living_currency: string;
  spent_week_minor: number;
  week_remaining_minor: number;
  spent_month_minor: number;
  month_cap_minor: number;
  /** Дата курсов и заметка, если кэш устарел (провайдер недоступен). */
  fx_as_of: string;
  fx_note?: string;
}

/**
 * null → профиля нет или не онбоарден (роутер отвечает 403).
 * FxUnavailable пробрасывается наверх (роутер отвечает 503).
 */
export async function buildOverview(
  repo: ScopedRepo,
  getFx: (currencies: string[]) => Promise<FxResult>,
  now: Date = new Date(),
): Promise<Overview | null> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) return null;

  const month = monthInTz(p.timezone, now);
  const today = todayInTz(p.timezone, now);
  const commits = (await repo.listCommitments()).results;
  const entries = (await repo.listIncomeEntries(month)).results;
  // P2-1: weeklyStatus считает только текущую неделю и месяц — история не нужна.
  // Неделя может начаться в прошлом месяце → берём более раннюю границу.
  const since = (() => {
    const mStart = `${month}-01`;
    const wStart = weekStartInTz(p.timezone, now);
    return wStart < mStart ? wStart : mStart;
  })();
  const expenses = (await repo.listExpenses(since)).results;

  const ccys = [
    p.income_currency,
    p.living_currency,
    ...entries.map((e) => e.currency),
    ...commits.map((c) => c.currency),
    ...expenses.map((e) => e.currency),
  ];
  const fxr = await getFx([...new Set(ccys)]);
  const pu = fxr.perUsd;

  // базовый доход: явный (income_minor>0) или вычисленный из обязательств
  const base = await baselineIncome(repo, p, { get: getFx }, today);
  const inc = resolveIncome({
    entries,
    typicalMinor: p.income_minor,
    incomeCcy: p.income_currency,
    perUsd: pu,
    ...(base.source === 'computed' ? { baseline: { amount: base.amount, currency: base.currency } } : {}),
  });

  const inLiving = expenses.map((e) => ({
    date: e.spent_on,
    amount: convert(e.amount_minor / 100, e.currency, p.living_currency, { perUsd: pu }),
  }));
  const s = weeklyStatus({
    expenses: inLiving,
    today,
    monthlyCap: p.living_cap_minor / 100,
    weeklyBudget: p.weekly_budget_minor / 100,
  });

  const toMinor = (n: number) => Math.round(round2(n) * 100);
  return {
    month,
    base_currency: p.base_currency,
    income_month_minor: Math.round(inc.amount * 100),
    income_month_currency: inc.currency,
    income_month_source: inc.source === 'override' ? 'actual' : inc.source,
    income_entries_count: inc.count,
    commitments: commits.map((c) => ({
      name: c.name,
      amount_minor: c.amount_minor,
      currency: c.currency,
      due_day: c.due_day,
    })),
    weekly_budget_minor: p.weekly_budget_minor,
    living_currency: p.living_currency,
    spent_week_minor: toMinor(s.weekSpent),
    week_remaining_minor: toMinor(s.weekRemaining),
    spent_month_minor: toMinor(s.monthSpent),
    month_cap_minor: p.living_cap_minor,
    fx_as_of: fxr.asOf,
    ...(fxr.stale ? { fx_note: `Курсы устарели — данные на ${fxr.asOf || '—'}, провайдер недоступен` } : {}),
  };
}
