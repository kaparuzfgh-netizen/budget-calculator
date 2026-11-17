/**
 * coins.ts — белый список монет для автоцен (T3b). Символы на CoinGecko не
 * уникальны (десятки «ETH»/«USDT» в разных сетях), поэтому тикер → id монеты
 * только из этого фиксированного списка; остальное — ручная цена.
 * Идентификаторы — публичные id CoinGecko (/coins/list). Чистые функции, без I/O.
 */
export const COINS: Record<string, { id: string; name: string }> = {
  BTC: { id: 'bitcoin', name: 'Bitcoin' },
  ETH: { id: 'ethereum', name: 'Ethereum' },
  USDT: { id: 'tether', name: 'Tether' },
  USDC: { id: 'usd-coin', name: 'USD Coin' },
  BNB: { id: 'binancecoin', name: 'BNB' },
  SOL: { id: 'solana', name: 'Solana' },
  XRP: { id: 'ripple', name: 'XRP' },
  TON: { id: 'the-open-network', name: 'Toncoin' },
  TRX: { id: 'tron', name: 'TRON' },
  DOGE: { id: 'dogecoin', name: 'Dogecoin' },
  ADA: { id: 'cardano', name: 'Cardano' },
  AVAX: { id: 'avalanche-2', name: 'Avalanche' },
  DOT: { id: 'polkadot', name: 'Polkadot' },
  LTC: { id: 'litecoin', name: 'Litecoin' },
  LINK: { id: 'chainlink', name: 'Chainlink' },
  BCH: { id: 'bitcoin-cash', name: 'Bitcoin Cash' },
  XLM: { id: 'stellar', name: 'Stellar' },
  ATOM: { id: 'cosmos', name: 'Cosmos' },
  NEAR: { id: 'near', name: 'NEAR' },
  MATIC: { id: 'polygon-ecosystem-token', name: 'Polygon (POL)' },
  POL: { id: 'polygon-ecosystem-token', name: 'Polygon (POL)' },
  DAI: { id: 'dai', name: 'Dai' },
  ETC: { id: 'ethereum-classic', name: 'Ethereum Classic' },
  XMR: { id: 'monero', name: 'Monero' },
  ARB: { id: 'arbitrum', name: 'Arbitrum' },
  OP: { id: 'optimism', name: 'Optimism' },
  APT: { id: 'aptos', name: 'Aptos' },
  SUI: { id: 'sui', name: 'Sui' },
  SHIB: { id: 'shiba-inu', name: 'Shiba Inu' },
  UNI: { id: 'uniswap', name: 'Uniswap' },
  WBTC: { id: 'wrapped-bitcoin', name: 'Wrapped Bitcoin' },
};

/** Тикеры из белого списка (для подсказки формы). */
export const SUPPORTED_TICKERS: string[] = Object.keys(COINS);

/** id монеты CoinGecko; только для kind='crypto' и тикера из списка, иначе null. */
export function coinIdFor(kind: string, ticker: string | null | undefined): string | null {
  if (kind !== 'crypto' || !ticker) return null;
  const c = Object.prototype.hasOwnProperty.call(COINS, ticker.trim().toUpperCase()) ? COINS[ticker.trim().toUpperCase()] : undefined;
  return c ? c.id : null;
}
