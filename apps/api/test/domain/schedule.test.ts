/** schedule.test.ts — каденсы регулярных платежей (миграция 0016): чистый домен. */
import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  cadenceLabel,
  dueDateFor,
  isOccurrencePaid,
  monthlyAmount,
  nextDueOn,
  occurrencesInRange,
  prevDueOn,
  type Cadence,
} from '../../src/domain/schedule';

const m = (due_day: number | null): Cadence => ({
  frequency: 'monthly',
  due_day,
  interval_days: null,
  anchor_on: null,
  due_month: null,
});
const i = (interval_days: number | null, anchor_on: string | null): Cadence => ({
  frequency: 'interval_days',
  due_day: null,
  interval_days,
  anchor_on,
  due_month: null,
});
const y = (due_day: number | null, due_month: number | null): Cadence => ({
  frequency: 'yearly',
  due_day,
  interval_days: null,
  anchor_on: null,
  due_month,
});

describe('dueDateFor — кламп дня к концу месяца (легаси-семантика)', () => {
  it('31 → последний день месяца; високосный февраль — 29', () => {
    expect(dueDateFor(31, 2026, 1)).toEqual({ y: 2026, m: 1, d: 31 });
    expect(dueDateFor(31, 2026, 2)).toEqual({ y: 2026, m: 2, d: 28 });
    expect(dueDateFor(31, 2024, 2)).toEqual({ y: 2024, m: 2, d: 29 });
    expect(dueDateFor(30, 2026, 4)).toEqual({ y: 2026, m: 4, d: 30 });
  });
});

describe('nextDueOn', () => {
  it('monthly: день ещё не наступил → этот месяц; прошёл → следующий; кламп', () => {
    expect(nextDueOn(m(15), '2026-10-10')).toBe('2026-10-15');
    expect(nextDueOn(m(15), '2026-10-15')).toBe('2026-10-15');
    expect(nextDueOn(m(15), '2026-10-16')).toBe('2026-11-15');
    expect(nextDueOn(m(31), '2026-02-10')).toBe('2026-02-28');
    expect(nextDueOn(m(31), '2026-03-01')).toBe('2026-03-31');
    expect(nextDueOn(m(15), '2026-12-20')).toBe('2027-01-15');
  });
  it('monthly без дня → null (платёж без сроков)', () => {
    expect(nextDueOn(m(null), '2026-10-10')).toBeNull();
  });
  it('interval_days: якорь в будущем → якорь; кратность от anchor_on', () => {
    const c = i(14, '2026-11-01');
    expect(nextDueOn(c, '2026-10-10')).toBe('2026-11-01');
    expect(nextDueOn(c, '2026-11-01')).toBe('2026-11-01');
    expect(nextDueOn(c, '2026-11-02')).toBe('2026-11-15');
    expect(nextDueOn(c, '2026-11-14')).toBe('2026-11-15');
    expect(nextDueOn(c, '2026-11-15')).toBe('2026-11-15');
    expect(nextDueOn(c, '2026-11-16')).toBe('2026-11-29');
  });
  it('interval_days: без шага/якоря → null', () => {
    expect(nextDueOn(i(null, '2026-11-01'), '2026-10-10')).toBeNull();
    expect(nextDueOn(i(14, null), '2026-10-10')).toBeNull();
    expect(nextDueOn(i(14, 'не-дата'), '2026-10-10')).toBeNull();
  });
  it('yearly: дата впереди → этот год; прошла → следующий; 29.02 → 28 в невисокосном', () => {
    const c = y(15, 3);
    expect(nextDueOn(c, '2026-01-10')).toBe('2026-03-15');
    expect(nextDueOn(c, '2026-03-15')).toBe('2026-03-15');
    expect(nextDueOn(c, '2026-03-16')).toBe('2027-03-15');
    expect(nextDueOn(y(29, 2), '2026-01-10')).toBe('2026-02-28');
    expect(nextDueOn(y(29, 2), '2024-01-10')).toBe('2024-02-29');
  });
});

describe('prevDueOn', () => {
  it('monthly: строго раньше даты — прошлый срок', () => {
    expect(prevDueOn(m(15), '2026-10-16')).toBe('2026-10-15');
    expect(prevDueOn(m(15), '2026-10-15')).toBe('2026-09-15');
    expect(prevDueOn(m(15), '2026-10-01')).toBe('2026-09-15');
    expect(prevDueOn(m(31), '2026-03-05')).toBe('2026-02-28');
  });
  it('interval_days: до якоря → null; затем кратные шаги', () => {
    const c = i(14, '2026-11-01');
    expect(prevDueOn(c, '2026-10-31')).toBeNull();
    expect(prevDueOn(c, '2026-11-02')).toBe('2026-11-01');
    expect(prevDueOn(c, '2026-11-15')).toBe('2026-11-01');
    expect(prevDueOn(c, '2026-11-16')).toBe('2026-11-15');
  });
  it('yearly: позапрошлый срок при ролловере года', () => {
    expect(prevDueOn(y(15, 3), '2026-03-16')).toBe('2026-03-15');
    expect(prevDueOn(y(15, 3), '2026-03-15')).toBe('2025-03-15');
  });
});

describe('occurrencesInRange', () => {
  it('monthly: по сроку на месяц, включая границы', () => {
    expect(occurrencesInRange(m(15), '2026-10-01', '2026-10-31')).toEqual(['2026-10-15']);
    expect(occurrencesInRange(m(1), '2026-10-01', '2026-10-31')).toEqual(['2026-10-01']);
    expect(occurrencesInRange(m(31), '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
    expect(occurrencesInRange(m(15), '2026-10-01', '2026-12-31')).toEqual([
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
    ]);
  });
  it('interval_days: несколько сроков за месяц', () => {
    expect(occurrencesInRange(i(14, '2026-11-01'), '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-01',
      '2026-11-15',
      '2026-11-29',
    ]);
  });
  it('yearly: один срок за год; пусто вне срока и у пустого окна', () => {
    expect(occurrencesInRange(y(15, 3), '2026-01-01', '2026-12-31')).toEqual(['2026-03-15']);
    expect(occurrencesInRange(y(15, 3), '2026-04-01', '2026-12-31')).toEqual([]);
    expect(occurrencesInRange(m(15), '2026-10-31', '2026-10-01')).toEqual([]);
  });
});

describe('isOccurrencePaid — окно (prevDue, occurrence]', () => {
  const rent = m(15);
  it('оплата в день срока и до срока (ранняя) гасит срок', () => {
    expect(isOccurrencePaid(rent, '2026-10-15', ['2026-10-15'])).toBe(true);
    expect(isOccurrencePaid(rent, '2026-10-15', ['2026-10-03'])).toBe(true);
    expect(isOccurrencePaid(rent, '2026-10-15', ['2026-09-16'])).toBe(true);
  });
  it('оплата до/в прошлый срок — следующий не покрыт; пропущенный — не покрыт поздним', () => {
    expect(isOccurrencePaid(rent, '2026-10-15', ['2026-09-15'])).toBe(false); // гасил сентябрьский
    expect(isOccurrencePaid(rent, '2026-09-15', ['2026-09-20'])).toBe(false); // поздняя — уже в окне октября
    expect(isOccurrencePaid(rent, '2026-10-15', ['2026-09-20'])).toBe(true); // та же оплата — окно октября
  });
  it('interval_days: период 14 дней', () => {
    const c = i(14, '2026-11-01');
    expect(isOccurrencePaid(c, '2026-11-15', ['2026-11-14'])).toBe(true);
    expect(isOccurrencePaid(c, '2026-11-15', ['2026-11-01'])).toBe(false); // гасил первый срок
    expect(isOccurrencePaid(c, '2026-11-01', ['2026-10-28'])).toBe(true); // ранняя до первого срока
  });
  it('yearly: окно — целый год', () => {
    const c = y(15, 3);
    expect(isOccurrencePaid(c, '2026-03-15', ['2025-12-01'])).toBe(true); // заранее оплатил
    expect(isOccurrencePaid(c, '2026-03-15', ['2025-03-15'])).toBe(false); // прошлогодний срок
    expect(isOccurrencePaid(c, '2026-03-15', ['2025-03-16'])).toBe(true);
  });
});

describe('monthlyAmount — нормализация к месяцу', () => {
  const amt = (a: number) => ({ amount_minor: Math.round(a * 100) });
  it('monthly — как есть; yearly /12; interval ×30.4375/n', () => {
    expect(monthlyAmount({ ...m(1), ...amt(700) })).toBe(700);
    expect(monthlyAmount({ ...y(15, 3), ...amt(1200) })).toBe(100);
    expect(monthlyAmount({ ...i(14, '2026-11-01'), ...amt(140) })).toBeCloseTo(304.375, 6);
    expect(monthlyAmount({ ...i(30, '2026-11-01'), ...amt(300) })).toBeCloseTo(304.375, 6);
    // битый interval без шага — не делим на 0
    expect(monthlyAmount({ ...i(null, '2026-11-01'), ...amt(100) })).toBe(100);
  });
});

describe('cadenceLabel + addDaysIso', () => {
  it('подписи по-русски', () => {
    expect(cadenceLabel(m(1))).toBe('1 числа');
    expect(cadenceLabel(m(null))).toBe('без даты');
    expect(cadenceLabel(i(14, '2026-11-01'))).toBe('каждые 14 дн');
    expect(cadenceLabel(y(15, 3))).toBe('15 марта');
    expect(cadenceLabel(y(29, 2))).toBe('29 февраля');
  });
  it('addDaysIso: ролловер месяца/года', () => {
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('битая ISO-дата → DomainError', () => {
    expect(() => nextDueOn(m(15), 'не-дата')).toThrow();
    expect(() => occurrencesInRange(m(15), '2026-13-01', '2026-12-31')).toThrow();
    expect(() => addDaysIso('2026-02-30', 1)).toThrow();
  });
});
