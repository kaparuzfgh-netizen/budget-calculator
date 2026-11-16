/**
 * digest.ts — чистые функции дайджеста месяца (T2): без I/O, «сегодня» — параметром.
 */
import { addMonths, daysInMonth } from './dates';

/** Час (локальный), до которого 1-го числа догоняем дайджест прошлого месяца. */
export const DIGEST_CATCHUP_UNTIL_HOUR = 12;

export interface DigestTarget {
  /** 0 — текущий месяц (последний день), −1 — прошлый (catch-up 1-го числа). */
  offset: 0 | -1;
  /** 'YYYY-MM' месяца, за который шлём дайджест (ключ claim). */
  key: string;
}

/**
 * Какой месяц суммировать в данный локальный момент.
 * Последний день месяца и hour ≥ startHour → текущий; 1-е число и
 * hour < DIGEST_CATCHUP_UNTIL_HOUR → прошлый (повтор после сбоя); иначе null.
 */
export function digestTarget(localIso: string, hour: number, startHour: number): DigestTarget | null {
  const day = Number(localIso.slice(8, 10));
  if (day === daysInMonth(localIso) && hour >= startHour) return { offset: 0, key: localIso.slice(0, 7) };
  if (day === 1 && hour < DIGEST_CATCHUP_UNTIL_HOUR) {
    return { offset: -1, key: addMonths(localIso, -1).slice(0, 7) };
  }
  return null;
}

/** (доход − обязательные − повседневные) / доход; доход ≤ 0 → null. Может быть < 0. */
export function savingsRate(income: number, obligatory: number, living: number): number | null {
  if (!(income > 0)) return null;
  return (income - obligatory - living) / income;
}

export interface CatAmount {
  id: number | null;
  name: string;
  emoji: string;
  amount: number;
}
export interface CatMover extends CatAmount {
  /** Рост к прошлому месяцу (amount − prev); null — прошлого месяца нет. */
  delta: number | null;
}

/**
 * Топ-n категорий: по росту суммы к прошлому месяцу (только положительный);
 * нет прошлого месяца (prev пуст) или роста нет — топ-n по сумме.
 */
export function topCategoryMovers(cur: CatAmount[], prev: CatAmount[], n = 2): CatMover[] {
  const prevAmt = new Map(prev.map((c) => [c.id, c.amount]));
  const hasPrev = prev.some((c) => c.amount > 0);
  const withDelta: CatMover[] = cur
    .filter((c) => c.amount > 0)
    .map((c) => ({ ...c, delta: hasPrev ? c.amount - (prevAmt.get(c.id) ?? 0) : null }));
  if (hasPrev) {
    const grown = withDelta.filter((c) => (c.delta ?? 0) > 0).sort((a, b) => b.delta! - a.delta!);
    if (grown.length) return grown.slice(0, n);
  }
  return withDelta.sort((a, b) => b.amount - a.amount).slice(0, n);
}
