import type { FxRates } from '../../src/domain/money';

/** Адаптер legacy-курсов {EURUSD, USDRUB, USDKGS} → perUsd (для golden-тестов). */
export function fxFromLegacy(fx: { EURUSD: number; USDRUB: number; USDKGS: number }): FxRates {
  return { perUsd: { EUR: 1 / fx.EURUSD, RUB: fx.USDRUB, KGS: fx.USDKGS } };
}
