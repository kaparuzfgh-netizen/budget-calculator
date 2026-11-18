/**
 * price-ref.ts — какой внешний источник цен подходит позиции (T3c). Чистая функция:
 * крипта из белого списка → CoinGecko; акция/облигация с корректным SECID → MOEX.
 */
import { coinIdFor } from './coins';
import { MOEX_MARKET, moexSecid, type MoexMarket } from './moex';
import type { HoldingKind } from './portfolio';

export type PriceRef =
  | { source: 'coingecko'; id: string }
  | { source: 'moex'; id: string; market: MoexMarket; kind: 'stock' | 'bond' };

export function priceRefFor(kind: HoldingKind, ticker: string | null | undefined): PriceRef | null {
  if (kind === 'crypto') {
    const id = coinIdFor(kind, ticker);
    return id ? { source: 'coingecko', id } : null;
  }
  if (kind === 'stock' || kind === 'bond') {
    const id = moexSecid(ticker);
    return id ? { source: 'moex', id, market: MOEX_MARKET[kind], kind } : null;
  }
  return null;
}
