/**
 * cashflow.ts — водопад месяца (порт CashflowEngine.computeWaterfall, чистый).
 * Все суммы выводятся в USD; валюты входа конвертируются через fx.perUsd.
 */
import { DomainError, num } from './errors';
import { convert, round2 } from './money';
import type { Currency, FxRates } from './money';

export interface MoneyAmount {
  amount: number;
  currency: Currency;
}

export interface WaterfallInput {
  income: MoneyAmount;
  baseIncomeUsd: number;
  mandatoryUsd: number; // обязательства реестра + ипотеки (уже в USD)
  livingCap: MoneyAmount;
  bonusPrepayShare: number; // доля дельты бонуса в досрочку
  bonusDcaShare: number; // доля дельты бонуса в DCA
  dcaTargets: Record<string, number>; // веса, сумма ≈ 1
  extraPrepay?: MoneyAmount | undefined;
  extraDcaUsd?: number | undefined;
  fx: FxRates;
}

export interface WaterfallResult {
  incomeUsd: number;
  livingUsd: number;
  surplusUsd: number; // incomeUsd − mandatoryUsd − livingUsd
  bonusDeltaUsd: number; // max(0, incomeUsd − baseIncomeUsd)
  toPrepayUsd: number;
  toDcaUsd: number;
  split: Record<string, number>; // toDcaUsd × вес
}

/**
 * computedBaselineUsd — «базовый доход» для плана/каскада, когда явный доход
 * не задан (profiles.income_minor = 0): сумма месячных обязательств
 * (регулярные платежи + бюджет повседневных + месячный платёж каждого
 * активного кредита) в USD, округлённая до центов.
 * Личные займы (loans) не входят — выплаты нерегулярные.
 * Входные суммы: commitments в minor units, платежи кредитов — float
 * (уже нормализованные в месяц через DebtView.monthlyPayment).
 */
export function computedBaselineUsd(input: {
  commits: { amount_minor: number; currency: Currency }[];
  livingCapMinor: number;
  livingCcy: Currency;
  debtMonthly: { amount: number; currency: Currency }[];
  pu: Record<string, number>;
}): number {
  let sum = 0;
  for (const c of input.commits) sum += convert(c.amount_minor / 100, c.currency, 'USD', { perUsd: input.pu });
  sum += convert(input.livingCapMinor / 100, input.livingCcy, 'USD', { perUsd: input.pu });
  for (const d of input.debtMonthly) sum += convert(d.amount, d.currency, 'USD', { perUsd: input.pu });
  return round2(sum);
}

export function computeWaterfall(input: WaterfallInput): WaterfallResult {
  num(input.baseIncomeUsd, 'baseIncomeUsd', { nonNegative: true });
  num(input.mandatoryUsd, 'mandatoryUsd', { nonNegative: true });
  num(input.bonusPrepayShare, 'bonusPrepayShare');
  num(input.bonusDcaShare, 'bonusDcaShare');
  if (input.bonusPrepayShare < 0 || input.bonusPrepayShare > 1 || input.bonusDcaShare < 0 || input.bonusDcaShare > 1) {
    throw new DomainError('SHARES_RANGE', 'Доли каскада должны быть в [0, 1]');
  }
  if (input.bonusPrepayShare + input.bonusDcaShare > 1 + 1e-9) {
    throw new DomainError('SHARES_SUM', 'Сумма долей каскада больше 1');
  }
  let wSum = 0;
  for (const [k, w] of Object.entries(input.dcaTargets)) {
    num(w, `dcaTargets.${k}`, { nonNegative: true });
    wSum += w;
  }
  if (Math.abs(wSum - 1) > 1e-6) {
    throw new DomainError('TARGETS_SUM', `Веса DCA должны суммироваться в 1, получено ${wSum}`);
  }

  const incomeUsd = convert(input.income.amount, input.income.currency, 'USD', input.fx);
  const livingUsd = convert(input.livingCap.amount, input.livingCap.currency, 'USD', input.fx);
  const surplusUsd = incomeUsd - input.mandatoryUsd - livingUsd;
  const bonusDeltaUsd = Math.max(0, incomeUsd - input.baseIncomeUsd);
  const extraPrepayUsd = input.extraPrepay
    ? convert(input.extraPrepay.amount, input.extraPrepay.currency, 'USD', input.fx)
    : 0;
  const extraDcaUsd = input.extraDcaUsd ?? 0;
  num(extraDcaUsd, 'extraDcaUsd', { nonNegative: true });

  const toPrepayUsd = bonusDeltaUsd * input.bonusPrepayShare + extraPrepayUsd;
  const toDcaUsd = bonusDeltaUsd * input.bonusDcaShare + extraDcaUsd;
  const split: Record<string, number> = {};
  for (const [k, w] of Object.entries(input.dcaTargets)) {
    split[k] = toDcaUsd * w;
  }

  return { incomeUsd, livingUsd, surplusUsd, bonusDeltaUsd, toPrepayUsd, toDcaUsd, split };
}
