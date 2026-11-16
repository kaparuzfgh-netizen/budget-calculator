import { describe, expect, it } from 'vitest';
import { digestTarget, savingsRate, topCategoryMovers } from '../../src/domain/digest';

describe('digestTarget', () => {
  it('последний день и час ≥ старта → текущий месяц', () => {
    expect(digestTarget('2026-11-30', 10, 10)).toEqual({ offset: 0, key: '2026-11' });
    expect(digestTarget('2026-11-30', 9, 10)).toBeNull();
    expect(digestTarget('2026-11-29', 22, 10)).toBeNull();
  });
  it('февраль и високосный год', () => {
    expect(digestTarget('2027-02-28', 12, 10)?.key).toBe('2027-02');
    expect(digestTarget('2028-02-28', 12, 10)).toBeNull();
    expect(digestTarget('2028-02-29', 12, 10)?.key).toBe('2028-02');
  });
  it('1-е число до полудня → прошлый месяц (catch-up), через границу года', () => {
    expect(digestTarget('2026-12-01', 3, 10)).toEqual({ offset: -1, key: '2026-11' });
    expect(digestTarget('2027-01-01', 11, 10)).toEqual({ offset: -1, key: '2026-12' });
    expect(digestTarget('2027-01-01', 12, 10)).toBeNull();
  });
});

describe('savingsRate', () => {
  it('считает долю, допускает минус, доход ≤ 0 → null', () => {
    expect(savingsRate(1000, 400, 300)).toBeCloseTo(0.3);
    expect(savingsRate(1000, 800, 500)).toBeCloseTo(-0.3);
    expect(savingsRate(0, 1, 1)).toBeNull();
  });
});

describe('topCategoryMovers', () => {
  const c = (id: number | null, amount: number) => ({ id, name: `c${id}`, emoji: 'x', amount });
  it('по росту к прошлому месяцу', () => {
    const r = topCategoryMovers([c(1, 100), c(2, 300), c(3, 50)], [c(1, 90), c(2, 100), c(3, 60)]);
    expect(r.map((x) => x.id)).toEqual([2, 1]);
    expect(r[0]!.delta).toBe(200);
  });
  it('нет прошлого или роста — топ по сумме', () => {
    expect(topCategoryMovers([c(1, 10), c(2, 30)], []).map((x) => x.id)).toEqual([2, 1]);
    expect(topCategoryMovers([c(1, 10), c(2, 30)], [c(1, 50), c(2, 50)]).map((x) => x.id)).toEqual([2, 1]);
  });
});
