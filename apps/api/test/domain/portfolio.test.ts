import { describe, expect, it } from 'vitest';
import {
  allocation,
  dcaTargetsFrom,
  depositAccrued,
  holdingValueMinor,
  parseTargets,
  pnlMinor,
  portfolioTotals,
  priceStale,
  validateTargets,
} from '../../src/domain/portfolio';
import { computeWaterfall } from '../../src/domain/cashflow';

describe('portfolio: оценка', () => {
  it('qty×price, иначе amount', () => {
    expect(holdingValueMinor({ quantity: '0.1', price: '30000.5', amount_minor: null })).toBe(300005);
    expect(holdingValueMinor({ quantity: null, price: null, amount_minor: 50000 })).toBe(50000);
    expect(holdingValueMinor({ quantity: null, price: null, amount_minor: null })).toBe(0);
  });
  it('P&L с и без цены покупки', () => {
    expect(pnlMinor({ quantity: '2', price: '110', avg_price: '100' })).toBe(2000);
    expect(pnlMinor({ quantity: '2', price: '90', avg_price: '100' })).toBe(-2000);
    expect(pnlMinor({ quantity: '2', price: '90', avg_price: null })).toBeNull();
  });
  it('цена старше 30 дней — устарела', () => {
    expect(priceStale({ price: '1', price_on: '2026-10-01' }, '2026-11-17')).toBe(true);
    expect(priceStale({ price: '1', price_on: '2026-11-01' }, '2026-11-17')).toBe(false);
    expect(priceStale({ price: null, price_on: null }, '2026-11-17')).toBe(false);
  });
});

describe('portfolio: вклад', () => {
  const dep = { kind: 'deposit' as const, amount_minor: 36_500_00, rate: 10, opened_on: '2026-01-01', matures_on: null };
  it('простые проценты по дням', () => {
    // 36500 × 10% × 100/365 = 1000.00
    expect(depositAccrued(dep, '2026-04-11')).toBe(1_000_00);
  });
  it('обрезка по matures_on', () => {
    expect(depositAccrued({ ...dep, matures_on: '2026-04-11' }, '2027-01-01')).toBe(1_000_00);
  });
  it('нет ставки/даты — null; до открытия — 0', () => {
    expect(depositAccrued({ ...dep, rate: null }, '2026-04-11')).toBeNull();
    expect(depositAccrued({ ...dep, opened_on: null }, '2026-04-11')).toBeNull();
    expect(depositAccrued(dep, '2025-12-01')).toBe(0);
  });
});

describe('portfolio: итоги и цели', () => {
  it('валюта без курса — в missing, итог по остальным', () => {
    const t = portfolioTotals(
      [
        { kind: 'deposit', currency: 'USD', valueMinor: 100_00 },
        { kind: 'crypto', currency: 'EUR', valueMinor: 50_00 },
        { kind: 'stock', currency: 'XXX', valueMinor: 10_00 },
      ],
      { USD: 1, EUR: 0.5 },
      'USD',
    );
    expect(t.missing).toEqual(['XXX']);
    expect(t.totalMinor).toBe(200_00);
    expect(t.byKind).toEqual({ deposit: 100_00, crypto: 100_00 });
    expect(allocation(t.byKind)).toEqual({ deposit: 50, crypto: 50 });
  });
  it('validateTargets', () => {
    expect(validateTargets({ deposit: 60, crypto: 40, stock: 0 })).toEqual({ deposit: 60, crypto: 40 });
    expect(() => validateTargets({ deposit: 60 })).toThrow();
    expect(() => validateTargets({ deposit: 50.5, crypto: 49.5 })).toThrow();
    expect(() => validateTargets({ gold: 100 })).toThrow();
    expect(parseTargets('not json')).toBeNull();
    expect(parseTargets(null)).toBeNull();
  });
  it('dcaTargetsFrom: без целей {USD:1}; с целями — веса, waterfall не падает', () => {
    expect(dcaTargetsFrom(null)).toEqual({ USD: 1 });
    const w = dcaTargetsFrom({ deposit: 60, crypto: 40 });
    expect(w).toEqual({ deposit: 0.6, crypto: 0.4 });
    const r = computeWaterfall({
      income: { amount: 2000, currency: 'USD' },
      baseIncomeUsd: 1000,
      mandatoryUsd: 500,
      livingCap: { amount: 300, currency: 'USD' },
      bonusPrepayShare: 0.5,
      bonusDcaShare: 0.5,
      dcaTargets: dcaTargetsFrom({ deposit: 33, crypto: 33, stock: 34 }),
      fx: { perUsd: {} },
    });
    expect(r.toDcaUsd).toBe(500);
    expect(r.split.deposit).toBeCloseTo(165);
  });
});
