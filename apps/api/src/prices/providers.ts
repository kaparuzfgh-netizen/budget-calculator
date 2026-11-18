/**
 * providers.ts — сборка провайдеров автоцен из env/тестовых подмен (T3b/T3c).
 *  - CoinGecko: есть секрет COINGECKO_API_KEY (иначе null — ноль запросов);
 *  - MOEX ISS: ключа нет, включён переменной [vars] MOEX_PRICES = "on" (иначе null — ноль запросов к бирже).
 */
import type { Env } from '../env';
import { createCoinGecko } from './coingecko';
import { createMoex, type MoexProvider } from './moex';
import type { PriceProvider } from './provider';

export interface PriceProviders {
  coingecko: PriceProvider | null;
  moex: MoexProvider | null;
}

export function resolveProviders(
  env: Pick<Env, 'COINGECKO_API_KEY' | 'MOEX_PRICES'>,
  override: { prices?: PriceProvider | null | undefined; moex?: MoexProvider | null | undefined } = {},
): PriceProviders {
  return {
    coingecko:
      override.prices !== undefined ? override.prices : env.COINGECKO_API_KEY ? createCoinGecko(env.COINGECKO_API_KEY) : null,
    moex: override.moex !== undefined ? override.moex : env.MOEX_PRICES === 'on' ? createMoex() : null,
  };
}
