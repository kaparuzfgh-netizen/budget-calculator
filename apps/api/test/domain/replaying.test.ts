import { describe, expect, it } from 'vitest';
import { pickPrepayTarget, previewPrepay, projection, replay } from '../../src/domain';

const SBER = { rate: 0.119, frequency: 'monthly' as const, initialBalance: 1_287_312, initialPayment: 44_282 };

describe('replay', () => {
  it('без событий → начальное состояние', () => {
    const s = replay(SBER, []);
    expect(s.balance).toBe(SBER.initialBalance);
    expect(s.payment).toBe(SBER.initialPayment);
    expect(s.paymentsMade).toBe(0);
    expect(s.remainingPeriods).toBeCloseTo(34.46, 1);
  });

  it('платежи монотонно уменьшают баланс', () => {
    const s = replay(SBER, [
      { kind: 'payment', amount: 44_282 },
      { kind: 'payment', amount: 44_282 },
      { kind: 'payment', amount: 44_282 },
    ]);
    expect(s.paymentsMade).toBe(3);
    expect(s.balance).toBeLessThan(SBER.initialBalance);
    expect(s.balance).toBeGreaterThan(0);
  });

  it('prepay → replay равен previewPrepay (срок сохранён)', () => {
    const events = [
      { kind: 'payment' as const, amount: 44_282 },
      { kind: 'prepay' as const, amount: 706_000 },
    ];
    const s = replay(SBER, events);
    const preview = previewPrepay(
      { rate: SBER.rate, frequency: 'monthly', balance: s.balance, payment: s.payment, paymentsMade: s.paymentsMade, effectivePeriods: s.effectivePeriods },
      1, // +1₽ досрочки сверху — предпросмотр того же механизма
    );
    expect(preview.balanceAfter).toBeCloseTo(s.balance - 1, 6);
  });

  it('reconcile: платёж не меняется, периоды пересчитываются', () => {
    const before = replay(SBER, [{ kind: 'payment', amount: 44_282 }]);
    const after = replay(SBER, [
      { kind: 'payment', amount: 44_282 },
      { kind: 'reconcile', amount: 1_200_000 },
    ]);
    expect(after.payment).toBe(before.payment);
    expect(after.balance).toBe(1_200_000);
    expect(after.effectivePeriods).not.toBe(before.effectivePeriods);
  });
});

describe('projection', () => {
  it('доп. досрочка ускоряет и уменьшает проценты', () => {
    const snap = { rate: SBER.rate, frequency: SBER.frequency, balance: SBER.initialBalance, payment: SBER.initialPayment };
    const base = projection(snap, 0, '2026-10-21');
    const faster = projection(snap, 50_000, '2026-10-21');
    expect(faster.monthsLeft).toBeLessThanOrEqual(base.monthsLeft);
    expect(faster.totalInterest).toBeLessThanOrEqual(base.totalInterest);
    expect(base.neverPaysOff).toBe(false);
    expect(base.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('payoffDate удерживает конец месяца (31 янв → 28 фев)', () => {
    const p = projection({ rate: 0.12, frequency: 'monthly', balance: 10_000, payment: 5_000 }, 0, '2026-01-31');
    // 3 периода → +3 мес от 31 янв = 30 апр (клэмп 31→30)
    expect(p.payoffDate).toBe('2026-04-30');
  });

  it('платёж < процентов → упор в 1200 и neverPaysOff', () => {
    const p = projection({ rate: 0.119, frequency: 'monthly', balance: 1_287_312, payment: 1_000 }, 0, '2026-10-21');
    expect(p.neverPaysOff).toBe(true);
    expect(p.periodsLeft).toBe(1200);
  });
});

describe('pickPrepayTarget', () => {
  it('самая высокая ставка; при равных — первый', () => {
    expect(pickPrepayTarget([{ id: 'A', rate: 0.0859 }, { id: 'B', rate: 0.119 }])?.id).toBe('B');
    expect(pickPrepayTarget([{ id: 'A', rate: 0.12 }, { id: 'B', rate: 0.12 }])?.id).toBe('A');
    expect(pickPrepayTarget([])).toBeUndefined();
  });
});
