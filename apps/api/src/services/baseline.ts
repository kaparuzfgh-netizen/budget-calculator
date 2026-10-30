/**
 * baseline.ts — «базовый доход» профиля.
 *
 * income_minor > 0  → explicit: пользователь задал базу сам (старое поведение).
 * income_minor = 0  → computed: вычисляется из обязательств пользователя —
 *   активные регулярные платежи + бюджет повседневных + месячный платёж
 *   каждого активного кредита (DebtView.monthlyPayment, уже нормализован
 *   в месяц). Личные займы (loans) НЕ входят — выплаты нерегулярные.
 *   Если обязательств нет — none (плана «от дохода» нет).
 *
 * Математика суммы — domain/cashflow.computedBaselineUsd; здесь — только
 * сбор данных из БД через scoped-repo и FX через getFxRates (кэш 6ч).
 */
import { computedBaselineUsd } from '../domain/cashflow';
import { convert, round2 } from '../domain/money';
import type { FxResult } from '../fx/service';
import type { ProfileRow, ScopedRepo } from '../db/repo';
import { debtViews } from './debts';

export interface BaselineIncome {
  source: 'explicit' | 'computed' | 'none';
  /** сумма в `currency` (всегда валюта дохода профиля), float. */
  amount: number;
  currency: string;
}

/**
 * Базовый доход профиля. today — локальная дата пользователя (для replay
 * долгов). FX-запрос один: валюты платежей + бюджета + кредитов + валюты дохода.
 */
export async function baselineIncome(
  repo: ScopedRepo,
  p: ProfileRow,
  fx: { get(ccys: string[]): Promise<FxResult> },
  today: string,
): Promise<BaselineIncome> {
  if (p.income_minor > 0) {
    return { source: 'explicit', amount: p.income_minor / 100, currency: p.income_currency };
  }
  const [commits, debts] = await Promise.all([repo.listCommitments(), debtViews(repo, today)]);
  const ccys = new Set<string>([
    p.income_currency,
    p.living_currency,
    ...commits.results.map((c) => c.currency),
    ...debts.map((v) => v.debt.currency),
  ]);
  const fxr = await fx.get([...ccys]);
  const usd = computedBaselineUsd({
    commits: commits.results.map((c) => ({ amount_minor: c.amount_minor, currency: c.currency })),
    livingCapMinor: p.living_cap_minor,
    livingCcy: p.living_currency,
    debtMonthly: debts.map((v) => ({ amount: v.monthlyPayment, currency: v.debt.currency })),
    pu: fxr.perUsd,
  });
  if (usd <= 0) return { source: 'none', amount: 0, currency: p.income_currency };
  return {
    source: 'computed',
    amount: round2(convert(usd, 'USD', p.income_currency, { perUsd: fxr.perUsd })),
    currency: p.income_currency,
  };
}
