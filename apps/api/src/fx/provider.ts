export interface FxLatest {
  perUsd: Record<string, number>;
  asOf: string; // 'YYYY-MM-DD'
}

export interface FxProvider {
  latest(currencies: string[]): Promise<FxLatest>;
}

export class FxUnavailable extends Error {
  readonly currency?: string | undefined;
  constructor(msg: string, currency?: string) {
    super(msg);
    this.name = 'FxUnavailable';
    this.currency = currency;
  }
}
