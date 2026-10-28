import type { FxPoint } from '../domain/fx';

export interface FxLatest {
  perUsd: Record<string, number>;
  asOf: string; // 'YYYY-MM-DD'
}

/** История одного запроса: base → quotes за [from..to] — массив точек по каждой валюте. */
export type FxHistory = Record<string, FxPoint[]>;

export interface FxProvider {
  latest(currencies: string[]): Promise<FxLatest>;
  /**
   * Дневная история курсов base→quote за диапазон дат ('YYYY-MM-DD').
   * Опционально: провайдер без истории → анализ пропускает пары.
   * Не заполняет выходные/праздники — серия приходит как есть.
   */
  history?(base: string, quotes: string[], from: string, to: string): Promise<FxHistory>;
}

export class FxUnavailable extends Error {
  readonly currency?: string | undefined;
  constructor(msg: string, currency?: string) {
    super(msg);
    this.name = 'FxUnavailable';
    this.currency = currency;
  }
}
