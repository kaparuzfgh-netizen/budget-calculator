import { describe, expect, it } from 'vitest';
import {
  annuityPayment,
  arbitrage,
  convert,
  derivePeriods,
  normalizedMonthly,
  previewPrepay,
  previewPrepayShortenTerm,
} from '../../src/domain';

// Числа-якоря из README v1 (проверены руками по банковскому графику).
describe('якоря из доков v1', () => {
  const SBER = { rate: 0.119, frequency: 'monthly' as const, balance: 1_287_312, payment: 44_282 };

  it('Сбербанк: derivePeriods ≈ 34.5 (±0.1)', () => {
    expect(Math.abs(derivePeriods(SBER.balance, SBER.rate, 12, SBER.payment) - 34.5)).toBeLessThan(0.1);
  });

  it('Сбербанк: ЧДП 706к → платёж ≈ 19 998 (±5), = P·(B−L)/B', () => {
    const n0 = derivePeriods(SBER.balance, SBER.rate, 12, SBER.payment);
    const p = previewPrepay({ ...SBER, paymentsMade: 0, effectivePeriods: n0 }, 706_000);
    expect(Math.abs(p.paymentAfter - 19_998)).toBeLessThan(5);
    const expected = (SBER.payment * p.balanceAfter) / SBER.balance;
    expect(p.paymentAfter / expected).toBeCloseTo(1, 6);
  });

  it('ЧДП «срок ↓»: платёж фиксирован, периодов меньше', () => {
    const p = previewPrepayShortenTerm(SBER, 706_000);
    expect(p.periodsBefore).toBeGreaterThan(p.periodsAfter);
    expect(p.monthsSaved).toBeGreaterThan(0);
  });

  it('Т-Банк: biweekly 17 314 → normalizedMonthly = 37 513.67 (±0.01)', () => {
    expect(Math.abs(normalizedMonthly(17_314, 'biweekly') - 37_513.67)).toBeLessThan(0.01);
  });

  it('арбитраж: 100к вклад 16% vs долг 11.9% → delta 4 100', () => {
    const r = arbitrage({ amount: 100_000, depositRate: 0.16, debtRate: 0.119 });
    expect(r.depositYield).toBe(16_000);
    expect(r.interestSaved).toBe(11_900);
    expect(r.delta).toBeCloseTo(4_100, 10);
    expect(r.depositWins).toBe(true);
  });
});

describe('инварианты', () => {
  it('annuityPayment/derivePeriods — обратные функции (round trip)', () => {
    const cases: [number, number, number, number][] = [
      [1_287_312, 0.119, 12, 34.5],
      [500_000, 0.16, 12, 48],
      [800_000, 0.0859, 26, 78],
    ];
    for (const [b, r, ppy, n] of cases) {
      const p = annuityPayment(b, r, ppy, n);
      expect(derivePeriods(b, r, ppy, p)).toBeCloseTo(n, 6);
    }
  });

  it('платёж не покрывает проценты → Infinity; ставка 0 → линейно', () => {
    expect(derivePeriods(1_000_000, 0.12, 12, 9_000)).toBe(Infinity);
    expect(derivePeriods(36_000, 0, 12, 1_000)).toBe(36);
    expect(annuityPayment(36_000, 0, 12, 36)).toBe(1_000);
  });

  it('convert: известные курсы, обратимость, ошибки', () => {
    const fx = { perUsd: { EUR: 1 / 1.09, RUB: 97, KGS: 86.5 } };
    expect(convert(6_200, 'EUR', 'USD', fx)).toBeCloseTo(6_758, 2);
    expect(convert(6_758, 'USD', 'EUR', fx)).toBeCloseTo(6_200, 0);
    expect(convert(100, 'USD', 'USD', fx)).toBe(100);
  });
});
