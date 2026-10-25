import { DomainError, num } from './errors';

/** Код валюты: ISO 4217 и крипто-тикеры (BTC и т.п.). */
export type Currency = string;
const RE_CCY = /^[A-Z]{3,5}$/;

/**
 * Курсы: сколько единиц валюты за 1 USD. USD сам по себе = 1 (можно не задавать).
 * Эквивалент legacy {EURUSD, USDRUB, USDKGS}: perUsd.EUR = 1/EURUSD и т.д.
 * (адаптер для голден-тестов — test/domain/fx-legacy.ts).
 */
export interface FxRates {
  perUsd: Record<string, number>;
}

function checkCcy(c: Currency): Currency {
  if (typeof c !== 'string' || !RE_CCY.test(c)) {
    throw new DomainError('BAD_CURRENCY', `Неизвестный код валюты '${c}'`);
  }
  return c;
}

function rateOf(fx: FxRates, c: Currency): number {
  if (c === 'USD') return 1;
  const r = fx.perUsd[c];
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) {
    throw new DomainError('NO_RATE', `Нет курса для валюты '${c}' (perUsd)`);
  }
  return r;
}

/** Конвертация через базу USD: amount/perUsd[from] → USD → *perUsd[to]. */
export function convert(amount: number, from: Currency, to: Currency, fx: FxRates): number {
  num(amount, 'amount');
  const usd = amount / rateOf(fx, checkCcy(from.toUpperCase()));
  return usd * rateOf(fx, checkCcy(to.toUpperCase()));
}

/** Округление до копеек (для вывода; хранение в minor units — отдельный шаг). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
