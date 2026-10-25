import { describe, expect, it } from 'vitest';
import {
  annuityPayment,
  arbitrage,
  computeWaterfall,
  convert,
  derivePeriods,
  normalizedMonthly,
  projection,
  replay,
  weeklyStatus,
} from '../../src/domain';
import { fxFromLegacy } from './fx-legacy';
import golden from './golden.legacy.json';

/**
 * Golden-тест: числа из НАСТОЯЩЕГО legacy-кода (scripts/gen-golden.js →
 * golden.legacy.json, закоммичен; CI не пересчитывает).
 * Точность: 1e-6 относительная; денежные поля — до 0.01.
 */
const rel = (exp: number, tol = 1e-6) => (exp === 0 ? 0 : Math.abs(exp) * tol);
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= Math.max(rel(b, tol), 1e-9);

/* eslint-disable @typescript-eslint/no-explicit-any -- фикстура внешне нетипизирована */
const cases = golden.cases as { fn: string; args: any; result: any }[];

describe('golden vs legacy', () => {
  it('annuityPayment / derivePeriods', () => {
    for (const c of cases.filter((c) => c.fn === 'annuityPayment')) {
      const [b, r, ppy, n] = c.args;
      expect(close(annuityPayment(b, r, ppy, n), c.result), `annuity ${JSON.stringify(c.args)}`).toBe(true);
    }
    for (const c of cases.filter((c) => c.fn === 'derivePeriods')) {
      const [b, r, ppy, p] = c.args;
      const got = derivePeriods(b, r, ppy, p);
      if (c.result === null || c.result === 'Infinity') expect(got).toBe(Infinity);
      else expect(close(got, c.result), `derive ${JSON.stringify(c.args)}`).toBe(true);
    }
  });

  it('normalizedMonthly', () => {
    for (const c of cases.filter((c) => c.fn === 'normalizedMonthly')) {
      expect(normalizedMonthly(c.args.payment, c.args.type)).toBeCloseTo(c.result, 6);
    }
  });

  it('projection (числовые поля)', () => {
    for (const c of cases.filter((c) => c.fn === 'projection')) {
      const [type, rate, balance, payment, extra] = c.args;
      const r = projection({ rate, frequency: type, balance, payment }, extra, '2026-10-21');
      expect(r.periodsLeft).toBe(c.result.periodsLeft);
      expect(r.monthsLeft).toBeCloseTo(c.result.monthsLeft, 1);
      expect(Math.abs(r.totalInterest - c.result.totalInterestRUB)).toBeLessThanOrEqual(1);
      expect(close(r.periodPayment, c.result.monthlyPaymentRUB), `proj ${JSON.stringify(c.args)}`).toBe(true);
    }
  });

  it('arbitrage', () => {
    for (const c of cases.filter((c) => c.fn === 'arbitrage')) {
      const r = arbitrage({ amount: c.args.amount, depositRate: c.args.depositRate, debtRate: c.args.debtRate });
      expect(r.depositYield).toBeCloseTo(c.result.depositYield, 6);
      expect(r.interestSaved).toBeCloseTo(c.result.interestSaved, 6);
      expect(r.delta).toBeCloseTo(c.result.delta, 6);
      expect(r.depositWins).toBe(c.result.depositWins);
    }
  });

  it('convert', () => {
    for (const c of cases.filter((c) => c.fn === 'convert')) {
      const { amount, from, to, fx } = c.args;
      expect(close(convert(amount, from, to, fxFromLegacy(fx)), c.result), `convert ${JSON.stringify(c.args)}`).toBe(true);
    }
  });

  it('computeWaterfall', () => {
    for (const c of cases.filter((c) => c.fn === 'waterfall')) {
      const { opts, resolved } = c.args;
      const r = computeWaterfall({
        income: { amount: c.result.incomeAmount, currency: c.result.incomeCurrency },
        baseIncomeUsd: resolved.baseIncomeUsd,
        mandatoryUsd: resolved.mandatoryUsd,
        livingCap: resolved.livingCap,
        bonusPrepayShare: resolved.bonusPrepayShare,
        bonusDcaShare: resolved.bonusDcaShare,
        dcaTargets: resolved.dcaTargets,
        extraPrepay: opts.extraPrepayRUB ? { amount: opts.extraPrepayRUB, currency: 'RUB' } : undefined,
        extraDcaUsd: opts.extraDcaUSD,
        fx: fxFromLegacy(resolved.fx),
      });
      expect(close(r.incomeUsd, c.result.incomeUSD)).toBe(true);
      expect(close(r.livingUsd, c.result.livingUSD)).toBe(true);
      expect(close(r.surplusUsd, c.result.surplusUSD)).toBe(true);
      expect(close(r.bonusDeltaUsd, c.result.bonusDeltaUSD)).toBe(true);
      expect(close(r.toPrepayUsd, c.result.toPrepayUSD)).toBe(true);
      expect(close(r.toDcaUsd, c.result.toDcaUSD)).toBe(true);
      for (const [k, v] of Object.entries(c.result.split)) {
        expect(close(r.split[k] ?? NaN, v as number), `split.${k}`).toBe(true);
      }
    }
  });

  it('replay (журнал → состояние)', () => {
    for (const c of cases.filter((c) => c.fn === 'replay')) {
      const r = replay(c.args.params, c.args.events);
      expect(Math.abs(r.balance - c.result.balance)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(r.payment - c.result.payment)).toBeLessThanOrEqual(0.01);
      expect(r.paymentsMade).toBe(c.result.paymentsMade);
    }
  });

  it('weeklyStatus', () => {
    for (const c of cases.filter((c) => c.fn === 'weeklyStatus')) {
      const r = weeklyStatus(c.args);
      expect(r.weekSpent).toBeCloseTo(c.result.weekSpent, 2);
      expect(r.monthSpent).toBeCloseTo(c.result.monthSpent, 2);
      expect(r.burnRate).toBeCloseTo(c.result.burnRate, 4);
      expect(r.dailyAllowance).toBeCloseTo(c.result.dailyAllowance, 2);
      expect(r.daysLeft).toBe(c.result.daysLeft);
    }
  });
});
