/** Провайдер рыночных цен (T3b). Реализации — prices/coingecko.ts (крипта). */
export interface ProviderQuote {
  /** id монеты у провайдера ('bitcoin'). */
  id: string;
  /** Валюта котировки, верхний регистр ('USD'). */
  vs: string;
  /** Каноническая десятичная строка (domain/decimal). */
  price: string;
  /** ISO-время котировки у провайдера. */
  asOf: string;
}

export interface PriceProvider {
  readonly source: string;
  /** 'requested' (по умолчанию) — цена в запрошенной валюте; 'native' — в родной валюте бумаги (MOEX), ключ кэша — по id. */
  readonly quoteCurrency?: 'requested' | 'native';
  /** TTL кэша, мс (по умолчанию 15 мин). */
  readonly ttlMs?: number;
  /** Сколько дней можно отдавать просроченный кэш при сбое (по умолчанию 7). */
  readonly fallbackMaxAgeDays?: number;
  /** Пакетный запрос: ids × vs. Сбой/таймаут/кривой ответ → PriceUnavailable. */
  latest(ids: string[], vs?: string[]): Promise<{ quotes: ProviderQuote[] }>;
}

/** Провайдер недоступен; status — HTTP-код (без тел ответа, правило 10). */
export class PriceUnavailable extends Error {
  readonly status: number | undefined;
  constructor(status?: number) {
    super(status ? `price provider unavailable (${status})` : 'price provider unavailable');
    this.name = 'PriceUnavailable';
    this.status = status;
  }
}
