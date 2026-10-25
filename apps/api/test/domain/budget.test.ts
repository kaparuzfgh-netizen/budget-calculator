import { describe, expect, it } from 'vitest';
import {
  addMonths,
  computeWaterfall,
  convert,
  daysLeftInMonth,
  isoWeek,
  looksUnrealisticWeeklyAmount,
  previewPrepay,
  weeklyStatus,
} from '../../src/domain';

const FX = { perUsd: { EUR: 1 / 1.09, RUB: 97, KGS: 86.5 } };
const WF_BASE = {
  baseIncomeUsd: 5_800,
  mandatoryUsd: 2_000,
  livingCap: { amount: 60_000, currency: 'RUB' },
  bonusPrepayShare: 0.5,
  bonusDcaShare: 0.5,
  dcaTargets: { etf: 0.58, stocks: 0.23, crypto: 0.19 },
  fx: FX,
};

describe('computeWaterfall', () => {
  it('доход <= базы → дельта 0; доли и сплит сходятся', () => {
    const w = computeWaterfall({ ...WF_BASE, income: { amount: 5_000, currency: 'USD' } });
    expect(w.bonusDeltaUsd).toBe(0);
    expect(w.toDcaUsd).toBe(0);
    const sum = Object.values(w.split).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(w.toDcaUsd, 6);
  });

  it('дельта бонуса каскадом 50/50 + extras', () => {
    const w = computeWaterfall({
      ...WF_BASE,
      income: { amount: 7_000, currency: 'EUR' },
      extraPrepay: { amount: 80_000, currency: 'RUB' },
      extraDcaUsd: 500,
    });
    const incomeUsd = 7_000 * 1.09;
    expect(w.incomeUsd).toBeCloseTo(incomeUsd, 6);
    expect(w.bonusDeltaUsd).toBeCloseTo(incomeUsd - 5_800, 6);
    expect(w.toPrepayUsd).toBeCloseTo((incomeUsd - 5_800) * 0.5 + 80_000 / 97, 6);
    expect(w.toDcaUsd).toBeCloseTo((incomeUsd - 5_800) * 0.5 + 500, 6);
  });

  it('ошибки валидации долей и весов', () => {
    const bad = (p: object) => () => computeWaterfall({ ...WF_BASE, income: { amount: 1, currency: 'USD' }, ...p });
    expect(bad({ dcaTargets: { a: 0.5, b: 0.4 } })).toThrowError(/TARGETS_SUM|веса|суммир/i);
    expect(bad({ bonusPrepayShare: 0.7 })).toThrowError(/каскад/i);
  });
});

describe('weeklyStatus / ISO-недели', () => {
  it('ISO-неделя осведомлена о годе: граница 2026→2027', () => {
    // 2026 — 53-недельный ISO-год: 31 дек (чт) и 1 янв (пт) — неделя 53 ISO-года 2026;
    // календарный год отличается → legacy-сравнение getFullYear() эту неделю теряло.
    expect(isoWeek('2026-12-31')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2027-01-04')).toEqual({ year: 2027, week: 1 }); // пн — новая неделя
  });

  it('траты на границе года попадают в одну ISO-неделю', () => {
    const s = weeklyStatus({
      today: '2027-01-01',
      monthlyCap: 60_000,
      weeklyBudget: 15_000,
      expenses: [
        { date: '2026-12-28', amount: 1_000 }, // та же ISO-неделя 1/2027, др. календарный год
        { date: '2027-01-01', amount: 2_000 },
        { date: '2026-12-27', amount: 9_000 }, // неделя 52/2026 — не в счёт недели, в счёт декабря? нет: месяц у today = 2027-01
      ],
    });
    expect(s.weekSpent).toBe(3_000);
    expect(s.monthSpent).toBe(2_000); // только 2027-01-*
  });

  it('последний день месяца: daysLeft=1, границы месяца', () => {
    const s = weeklyStatus({ today: '2026-10-31', monthlyCap: 31_000, weeklyBudget: 7_000, expenses: [] });
    expect(s.daysLeft).toBe(1);
    expect(daysLeftInMonth('2026-02-28')).toBe(1);
    expect(daysLeftInMonth('2028-02-28')).toBe(2); // високосный
  });

  it('looksUnrealisticWeeklyAmount: порог передаётся параметром', () => {
    expect(looksUnrealisticWeeklyAmount(1_500_000, 1_000_000)).toBe(true);
    expect(looksUnrealisticWeeklyAmount(5_000, 1_000_000)).toBe(false);
  });
});

describe('addMonths', () => {
  it('клэмп конца месяца', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29'); // високосный
    expect(addMonths('2026-10-31', -1)).toBe('2026-09-30');
    expect(addMonths('2026-10-21', 14)).toBe('2027-12-21');
  });
});

describe('DomainError', () => {
  // instanceof надёжнее не проверять — в workerd возможны realm-нюансы; проверяем code.
  const codeOf = (f: () => unknown) => {
    try {
      f();
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };
  it('плохие входы → DomainError с code', () => {
    expect(codeOf(() => convert(NaN, 'EUR', 'USD', FX))).toBe('BAD_NUMBER');
    expect(codeOf(() => convert(1, 'XXX!', 'USD', FX))).toBe('BAD_CURRENCY');
    expect(codeOf(() => convert(1, 'XAU', 'USD', FX))).toBe('NO_RATE');
    expect(codeOf(() => previewPrepay({ rate: 0.1, frequency: 'monthly', balance: 100, payment: 10 }, -5))).toBe('PREPAY_NOT_POSITIVE');
    expect(codeOf(() => previewPrepay({ rate: 0.1, frequency: 'monthly', balance: 100, payment: 10 }, 500))).toBe('PREPAY_EXCEEDS_BALANCE');
  });
});
