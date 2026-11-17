/**
 * prices.test.ts — T3b «Автоцены крипты»: домен (белый список, граница float,
 * приоритет авто/ручной), провайдер CoinGecko на фейковом fetch, сервис кэша
 * (TTL, пакет, пауза, запасной кэш), REST/бот: изоляция tenant, fail-closed,
 * ручная цена не теряется, логи без тикеров/ключа, export v8.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { coinIdFor } from '../src/domain/coins';
import { decFromProviderNumber } from '../src/domain/decimal';
import { effectivePrice } from '../src/domain/portfolio';
import { createCoinGecko } from '../src/prices/coingecko';
import { PriceUnavailable, type PriceProvider, type ProviderQuote } from '../src/prices/provider';
import { getQuotes } from '../src/prices/service';
import { renderInvest } from '../src/bot/invest';
import { portfolioView } from '../src/services/portfolio';
import { makePriceSource } from '../src/prices/service';

// ── домен ──
describe('coins / decFromProviderNumber', () => {
  it('coinIdFor: только crypto и белый список', () => {
    expect(coinIdFor('crypto', 'BTC')).toBe('bitcoin');
    expect(coinIdFor('crypto', 'btc')).toBe('bitcoin');
    expect(coinIdFor('stock', 'BTC')).toBeNull();
    expect(coinIdFor('crypto', 'NOPE')).toBeNull();
    expect(coinIdFor('crypto', 'constructor')).toBeNull();
    expect(coinIdFor('crypto', null)).toBeNull();
  });
  it('decFromProviderNumber: граница float → каноническая строка', () => {
    expect(decFromProviderNumber(64123.456789123)).toBe('64123.45678912');
    expect(decFromProviderNumber(1.2e-5)).toBe('0.000012');
    expect(decFromProviderNumber(1.123456789)).toBe('1.12345679');
    expect(decFromProviderNumber(5)).toBe('5');
    expect(decFromProviderNumber(1e-10)).toBeNull();
    for (const bad of [NaN, -1, 0, Infinity, 1e13, '5', null]) expect(decFromProviderNumber(bad), String(bad)).toBeNull();
  });
});

describe('effectivePrice', () => {
  const now = '2026-11-10T12:00:00.000Z';
  const today = '2026-11-10';
  const h = { kind: 'crypto' as const, price: '100', price_on: '2026-11-09', auto_price: 1 };
  const q = (hoursAgo: number) => ({ price: '200', asOf: new Date(Date.parse(now) - hoursAgo * 3_600_000).toISOString() });

  it('свежая авто (≤24ч) бьёт ручную', () => {
    const e = effectivePrice(h, q(2), today, now);
    expect(e).toMatchObject({ source: 'auto', price: '200', stale: false });
  });
  it('авто 3 дня vs ручная вчера → ручная', () => {
    expect(effectivePrice(h, q(72), today, now).source).toBe('manual');
  });
  it('авто 3 дня vs ручная 40 дней → авто (stale), ручная не меняется', () => {
    const old = { ...h, price_on: '2026-10-01' };
    const e = effectivePrice(old, q(72), today, now);
    expect(e).toMatchObject({ source: 'auto', price: '200', stale: true });
  });
  it('авто 8 дней → ручная', () => {
    expect(effectivePrice({ ...h, price_on: '2026-10-01' }, q(8 * 24), today, now).source).toBe('manual');
  });
  it('auto_price=0, профиль выкл, не crypto, нет котировки → ручная', () => {
    expect(effectivePrice({ ...h, auto_price: 0 }, q(1), today, now).source).toBe('manual');
    expect(effectivePrice(h, q(1), today, now, false).source).toBe('manual');
    expect(effectivePrice({ ...h, kind: 'stock' as never }, q(1), today, now).source).toBe('manual');
    expect(effectivePrice(h, null, today, now).source).toBe('manual');
  });
});

// ── провайдер CoinGecko ──
describe('createCoinGecko (фейковый fetch)', () => {
  const okBody = { bitcoin: { usd: 64000.5, eur: 59000.25, last_updated_at: 1_790_000_000 } };
  const mk = (res: () => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return res();
    });
    return { f: f as unknown as typeof fetch, calls };
  };

  it('ключ — в заголовке, не в URL; один пакетный запрос; котировки → строки', async () => {
    const { f, calls } = mk(() => new Response(JSON.stringify(okBody)));
    const p = createCoinGecko('SECRET-KEY', f);
    const { quotes } = await p.latest(['bitcoin', 'ethereum'], ['USD', 'EUR']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).not.toContain('SECRET-KEY');
    expect((calls[0]!.init.headers as Record<string, string>)['x-cg-demo-api-key']).toBe('SECRET-KEY');
    expect(calls[0]!.url).toContain('https://api.coingecko.com/api/v3/simple/price?');
    expect(calls[0]!.url).toContain('ids=bitcoin%2Cethereum');
    expect(calls[0]!.url).toContain('vs_currencies=usd%2Ceur');
    expect(quotes).toEqual([
      { id: 'bitcoin', vs: 'USD', price: '64000.5', asOf: new Date(1_790_000_000 * 1000).toISOString() },
      { id: 'bitcoin', vs: 'EUR', price: '59000.25', asOf: new Date(1_790_000_000 * 1000).toISOString() },
    ]);
  });

  it('HTTP 500/429/401 и кривой JSON → PriceUnavailable(status)', async () => {
    for (const status of [500, 429, 401]) {
      const { f } = mk(() => new Response('{}', { status }));
      await expect(createCoinGecko('k', f).latest(['bitcoin'], ['USD'])).rejects.toMatchObject({ status });
    }
    const bad = mk(() => new Response('{"bitcoin": 5}'));
    await expect(createCoinGecko('k', bad.f).latest(['bitcoin'], ['USD'])).rejects.toBeInstanceOf(PriceUnavailable);
    const notJson = mk(() => new Response('<html>'));
    await expect(createCoinGecko('k', notJson.f).latest(['bitcoin'], ['USD'])).rejects.toBeInstanceOf(PriceUnavailable);
  });

  it('сетевая ошибка/таймаут → PriceUnavailable без статуса', async () => {
    const { f } = mk(() => {
      throw new Error('timeout');
    });
    await expect(createCoinGecko('k', f).latest(['bitcoin'], ['USD'])).rejects.toMatchObject({ status: undefined });
  });
});

// ── окружение для сервисных/API-тестов ──
const JWT_SECRET = 'prices-secret';
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 0.5 }, asOf: '2026-11-10' }) };
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;
const TABLES = [
  'holdings', 'invites', 'household_members', 'households', 'conversation_state', 'income_entries',
  'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'profiles', 'consents',
  'reminder_log', 'rate_limit', 'audit_log', 'processed_updates', 'users',
];

/** Фейковый провайдер: считает вызовы, запоминает запрошенные ids, умеет падать. */
function fakeProvider(prices: Record<string, number> = { bitcoin: 60000, solana: 150 }) {
  const state = { calls: [] as { ids: string[]; vs: string[] }[], fail: null as number | null, asOf: new Date().toISOString() };
  const p: PriceProvider = {
    source: 'coingecko',
    async latest(ids, vs) {
      state.calls.push({ ids: [...ids], vs: [...vs] });
      if (state.fail !== null) throw new PriceUnavailable(state.fail || undefined);
      const quotes: ProviderQuote[] = [];
      for (const id of ids)
        for (const v of vs) if (id in prices && v === 'USD') quotes.push({ id, vs: v, price: String(prices[id]), asOf: state.asOf });
      return { quotes };
    },
  };
  return { p, state };
}

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM price_quotes').run();
  await env.DB.prepare('DELETE FROM price_provider_state').run();
  await env.DB.prepare('DELETE FROM fx_rates').run();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

const apiFor = (prices: PriceProvider | null) => {
  const app = createRouter({ fx, prices });
  return (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) =>
    app.fetch(
      new Request(`https://t${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.method && opts.method !== 'GET' && opts.body !== undefined ? JSON.stringify(opts.body) : null,
      }),
      tenv(),
    );
};

async function user(tgId: number, autoPrices = true) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  const r = scoped(env.DB, uid);
  await r.upsertProfile({
    base_currency: 'USD', income_currency: 'USD', living_currency: 'USD', timezone: 'UTC',
    income_minor: 100000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
  });
  if (autoPrices) await r.patchProfile({ auto_prices_enabled: 1 });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}

const btc = { kind: 'crypto', name: 'Биткоин', ticker: 'BTC', currency: 'USD', quantity: '2', price: '100', price_on: '2026-01-01' };
const sol = { kind: 'crypto', name: 'Солана', ticker: 'SOL', currency: 'USD', quantity: '10', price: '10', price_on: '2026-01-01' };

interface Item {
  id: number; name: string; price: string | null; price_on: string | null; price_source: string;
  effective_price: string | null; value_minor: number; price_stale: boolean; auto_supported: boolean;
  auto_note: string | null; auto_price: boolean;
}
interface List {
  items: Item[];
  total: { minor: number | null };
  auto: { enabled: boolean; available: boolean; as_of: string | null; stale: boolean; attribution: { text: string; url: string }; supported_tickers: string[] };
}
const listOf = async (api: ReturnType<typeof apiFor>, token: string) => (await (await api('/api/tma/holdings', { token })).json()) as List;
const postH = (api: ReturnType<typeof apiFor>, token: string, body: unknown) => api('/api/tma/holdings', { method: 'POST', token, body });

// ── сервис кэша ──
describe('getQuotes: кэш, TTL, пакет, пауза', () => {
  const refs = [{ id: 'bitcoin', vs: 'USD' }];
  const T0 = new Date('2026-11-10T12:00:00.000Z');

  it('провайдер null → ноль вызовов, пустая карта', async () => {
    const r = await getQuotes(env.DB, null, refs, T0);
    expect(r.map.size).toBe(0);
    expect(r.failed).toBe(false);
  });

  it('свежий кэш → 0 вызовов; просроченный → 1 вызов только по нужным', async () => {
    const { p, state } = fakeProvider();
    await getQuotes(env.DB, p, refs, T0);
    expect(state.calls).toHaveLength(1);
    await getQuotes(env.DB, p, refs, new Date(T0.getTime() + 5 * 60_000)); // в пределах 15 мин
    expect(state.calls).toHaveLength(1);
    const both = [...refs, { id: 'solana', vs: 'USD' }];
    const later = new Date(T0.getTime() + 20 * 60_000);
    await getQuotes(env.DB, p, both, later); // bitcoin просрочен, solana нет в кэше → один пакет
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]!.ids.sort()).toEqual(['bitcoin', 'solana']);
    // теперь solana свежа, bitcoin свеж → ничего
    await getQuotes(env.DB, p, both, new Date(later.getTime() + 60_000));
    expect(state.calls).toHaveLength(2);
    // позже: просрочен только bitcoin? оба (одинаковый fetched_at) — но запрашиваем только bitcoin
    await getQuotes(env.DB, p, refs, new Date(later.getTime() + 30 * 60_000));
    expect(state.calls[2]!.ids).toEqual(['bitcoin']);
  });

  it('сбой → запасной кэш ≤7 дней и stale; 429 → пауза без повторных вызовов', async () => {
    const { p, state } = fakeProvider();
    await getQuotes(env.DB, p, refs, T0);
    state.fail = 429;
    const later = new Date(T0.getTime() + 60 * 60_000);
    const r = await getQuotes(env.DB, p, refs, later);
    expect(r.stale).toBe(true);
    expect(r.failed).toBe(true);
    expect(r.map.get('bitcoin|USD')?.price).toBe('60000');
    expect(state.calls).toHaveLength(2);
    await getQuotes(env.DB, p, refs, new Date(later.getTime() + 60_000)); // в паузе
    expect(state.calls).toHaveLength(2);
    // после паузы (10 мин) снова пробуем
    state.fail = null;
    const r3 = await getQuotes(env.DB, p, refs, new Date(later.getTime() + 11 * 60_000));
    expect(state.calls).toHaveLength(3);
    expect(r3.failed).toBe(false);
    expect(r3.stale).toBe(false);
  });

  it('кэш старше 7 дней не используется', async () => {
    const { p, state } = fakeProvider();
    await getQuotes(env.DB, p, refs, T0);
    state.fail = 500;
    const r = await getQuotes(env.DB, p, refs, new Date(T0.getTime() + 8 * 86_400_000));
    expect(r.map.size).toBe(0);
  });

  it('price_quotes без user_id', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(price_quotes)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain('user_id');
  });
});

// ── REST / сервис портфеля ──
describe('/api/tma/holdings с автоценами', () => {
  it('автоцена подставляется, ручная не перезаписывается', async () => {
    const { p, state } = fakeProvider();
    const api = apiFor(p);
    const { token } = await user(1);
    await postH(api, token, btc);
    const l = await listOf(api, token);
    const it0 = l.items[0]!;
    expect(it0.price_source).toBe('auto');
    expect(it0.effective_price).toBe('60000');
    expect(it0.value_minor).toBe(12_000_000); // 2 × 60000 × 100
    expect(it0.price).toBe('100'); // ручная цена цела
    expect(it0.price_on).toBe('2026-01-01');
    expect(l.auto).toMatchObject({ enabled: true, available: true });
    expect(l.auto.attribution).toEqual({ text: 'Data provided by CoinGecko', url: 'https://www.coingecko.com/en/api' });
    expect(l.auto.supported_tickers).toContain('BTC');
    expect(state.calls).toHaveLength(1);
    const raw = await env.DB.prepare('SELECT price, price_on FROM holdings').first<{ price: string; price_on: string }>();
    expect(raw!.price).toMatch(/^enc1:/);
    expect(raw!.price_on).toBe('2026-01-01');
  });

  it('A не видит B: запрос к провайдеру — только свои монеты; A выкл → 0 вызовов', async () => {
    const { p, state } = fakeProvider();
    const api = apiFor(p);
    const a = await user(2);
    const b = await user(3);
    await postH(api, a.token, btc);
    await postH(api, b.token, sol);
    const la = await listOf(api, a.token);
    expect(la.items.map((i) => i.name)).toEqual(['Биткоин']);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.ids).toEqual(['bitcoin']);
    // A выключает автоцены, B включены → GET A: новых вызовов нет
    await api('/api/tma/profile', { method: 'PATCH', token: a.token, body: { auto_prices_enabled: false } });
    const before = state.calls.length;
    const off = await listOf(api, a.token);
    expect(off.items[0]!.price_source).toBe('manual');
    expect(state.calls).toHaveLength(before);
    // PATCH auto_price по id позиции B от A → 404, строка B не изменилась
    const idB = (await listOf(api, b.token)).items[0]!.id;
    const r = await api(`/api/tma/holdings/${idB}`, { method: 'PATCH', token: a.token, body: { auto_price: false } });
    expect(r.status).toBe(404);
    expect((await scoped(env.DB, b.uid).getHolding(idB))!.auto_price).toBe(1);
  });

  it('auto_price=false у позиции → ручная; создание/правка флага', async () => {
    const { p, state } = fakeProvider();
    const api = apiFor(p);
    const { token } = await user(4);
    const r = await postH(api, token, { ...btc, auto_price: false });
    expect(r.status).toBe(201);
    const l = await listOf(api, token);
    expect(l.items[0]).toMatchObject({ price_source: 'manual', auto_price: false, effective_price: '100' });
    expect(state.calls).toHaveLength(0);
    const id = l.items[0]!.id;
    expect((await api(`/api/tma/holdings/${id}`, { method: 'PATCH', token, body: { auto_price: true } })).status).toBe(200);
    expect((await listOf(api, token)).items[0]!.price_source).toBe('auto');
    expect((await postH(api, token, { ...btc, auto_price: 'yes' })).status).toBe(400);
  });

  it('без ключа: 200, всё ручное, available=false, fetch не вызывается', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const api = apiFor(null);
    const { token } = await user(5);
    await postH(api, token, btc);
    const res = await api('/api/tma/holdings', { token });
    expect(res.status).toBe(200);
    const l = (await res.json()) as List;
    expect(l.items[0]!.price_source).toBe('manual');
    expect(l.auto).toMatchObject({ enabled: true, available: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await api('/api/tma/holdings')).status).toBe(401);
  });

  it('провайдер падает → 200 с ручными/запасными ценами; в логах нет тикеров, id монет и ключа', async () => {
    const { p, state } = fakeProvider();
    state.fail = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = apiFor(p);
    const { token } = await user(6);
    await postH(api, token, btc);
    const res = await api('/api/tma/holdings', { token });
    expect(res.status).toBe(200);
    const l = (await res.json()) as List;
    expect(l.items[0]).toMatchObject({ price_source: 'manual', effective_price: '100', auto_note: 'no_quote' });
    const logged = [...errSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
    expect(logged).toContain('price_fetch_failed');
    expect(logged).toContain('500');
    for (const bad of ['BTC', 'bitcoin', 'Биткоин']) expect(logged).not.toContain(bad);
  });

  it('валюта без котировки → auto_note ccy_unsupported, ручная остаётся', async () => {
    const { p } = fakeProvider();
    const api = apiFor(p);
    const { token } = await user(7);
    await postH(api, token, { ...btc, currency: 'EUR' });
    const l = await listOf(api, token);
    expect(l.items[0]).toMatchObject({ price_source: 'manual', auto_note: 'ccy_unsupported' });
  });

  it('профиль: тумблер и auto_prices_available', async () => {
    const { p } = fakeProvider();
    const { token } = await user(8, false);
    const on = apiFor(p);
    const g0 = (await (await on('/api/tma/profile', { token })).json()) as { auto_prices_enabled: number; auto_prices_available: boolean };
    expect(g0).toMatchObject({ auto_prices_enabled: 0, auto_prices_available: true });
    expect((await on('/api/tma/profile', { method: 'PATCH', token, body: { auto_prices_enabled: true } })).status).toBe(200);
    const g1 = (await (await on('/api/tma/profile', { token })).json()) as { auto_prices_enabled: number };
    expect(g1.auto_prices_enabled).toBe(1);
    const g2 = (await (await apiFor(null)('/api/tma/profile', { token })).json()) as { auto_prices_available: boolean };
    expect(g2.auto_prices_available).toBe(false);
    expect((await on('/api/tma/profile', { method: 'PATCH', token, body: { auto_prices_enabled: 1 } })).status).toBe(400);
  });

  it('export: schema_version 9, auto_price и auto_prices_enabled', async () => {
    const { p } = fakeProvider();
    const api = apiFor(p);
    const { token } = await user(9);
    await postH(api, token, btc);
    const ex = (await (await api('/api/tma/export', { token })).json()) as {
      schema_version: number; holdings: { auto_price: number }[]; profile: { auto_prices_enabled: number };
    };
    expect(ex.schema_version).toBe(9);
    expect(ex.holdings[0]!.auto_price).toBe(1);
    expect(ex.profile.auto_prices_enabled).toBe(1);
  });
});

describe('бот: /invest с автоценами', () => {
  it('renderInvest: пометка и атрибуция CoinGecko только при автоценах', async () => {
    const { p } = fakeProvider();
    const api = apiFor(p);
    const { uid, token } = await user(10);
    await postH(api, token, btc);
    const r = scoped(env.DB, uid);
    const prof = (await r.getProfile())!;
    const get = async () => ({ perUsd: { USD: 1 }, asOf: '', stale: false });
    const v = await portfolioView(r, prof, get, '2026-11-10', makePriceSource(env.DB, p, new Date()));
    const html = renderInvest(v);
    expect(html).toContain('Автоцены крипты');
    expect(html).toContain('Data provided by CoinGecko');
    expect(html).toContain('https://www.coingecko.com/en/api');
    const v2 = await portfolioView(r, prof, get, '2026-11-10', null);
    expect(renderInvest(v2)).not.toContain('CoinGecko');
  });
});
