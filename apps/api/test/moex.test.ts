/**
 * moex.test.ts — T3c «Автоцены MOEX»: провайдер на фейковом fetch, сервис кэша
 * (native-ключи, 14 дней, паузы по источникам), REST/бот: облигации с НКД,
 * валюта CNY/ccy_mismatch, изоляция tenant, fail-closed, поиск, логи.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { createMoex } from '../src/prices/moex';
import { PriceUnavailable, type PriceProvider } from '../src/prices/provider';
import { getQuotes, makePriceSources } from '../src/prices/service';
import { renderInvest } from '../src/bot/invest';
import { portfolioView } from '../src/services/portfolio';

// ── фейковый ISS ──
interface Sec {
  board: string;
  ccy: string; // CURRENCYID
  faceunit?: string;
  face?: number;
  aci?: number;
  last: number | null;
  shortname: string;
}
const TABLE: Record<string, Sec> = {
  SBER: { board: 'TQBR', ccy: 'SUR', last: 300, shortname: 'Сбербанк' },
  GAZP: { board: 'TQBR', ccy: 'SUR', last: 120, shortname: 'ГАЗПРОМ' },
  NOTRADE: { board: 'TQBR', ccy: 'SUR', last: null, shortname: 'Без торгов' },
  OFZ1: { board: 'TQOB', ccy: 'SUR', faceunit: 'SUR', face: 1000, aci: 32.87, last: 96.1, shortname: 'ОФЗ 1' },
  CNYB: { board: 'TQOY', ccy: 'CNY', faceunit: 'CNY', face: 100, aci: 0.56, last: 100, shortname: 'Юаневая' },
};
const msk = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

function issFetch() {
  const calls: URL[] = [];
  const state = { status: 200, bad: false, at: new Date(Date.now() - 20 * 60_000) };
  const f = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    calls.push(u);
    if (state.status !== 200) return new Response('x', { status: state.status });
    if (state.bad) return new Response('{"oops":1}', { status: 200 });
    if (u.pathname === '/iss/securities.json') {
      const q = (u.searchParams.get('q') ?? '').toUpperCase();
      const market = u.searchParams.get('market');
      const rows: (string | null)[][] = Object.entries(TABLE)
        .filter(([id, s]) => id.startsWith(q) && (market === 'bonds') === !!s.face)
        .map(([id, s]) => [id, 'ISIN' + id, s.shortname, s.shortname, s.board, market === 'bonds' ? 'stock_bonds' : 'stock_shares']);
      rows.push(['IMOEX', null, 'Индекс', 'Индекс', 'INDX', 'stock_index']);
      return Response.json({ securities: { columns: ['secid', 'isin', 'shortname', 'name', 'primary_boardid', 'group'], data: rows } });
    }
    const ids = (u.searchParams.get('securities') ?? '').split(',');
    const secs: unknown[][] = [];
    const mds: unknown[][] = [];
    for (const id of ids) {
      const s = TABLE[id];
      if (!s) continue;
      secs.push([id, s.board, s.ccy, s.faceunit ?? null, s.face ?? null, s.aci ?? null, null, null]);
      mds.push([id, s.board, s.last, null, null, msk(new Date(state.at.getTime() + 15 * 60_000)), msk(state.at).slice(11)]);
      secs.push([id, 'SPEQ', 'SUR', null, null, null, null, null]); // чужой борд — игнорируется
      mds.push([id, 'SPEQ', 1, null, null, msk(state.at), msk(state.at).slice(11)]);
    }
    return Response.json({
      securities: { columns: ['SECID', 'BOARDID', 'CURRENCYID', 'FACEUNIT', 'FACEVALUE', 'ACCRUEDINT', 'PREVPRICE', 'PREVDATE'], data: secs },
      marketdata: { columns: ['SECID', 'BOARDID', 'LAST', 'LCURRENTPRICE', 'MARKETPRICE', 'SYSTIME', 'UPDATETIME'], data: mds },
    });
  });
  return { f: f as unknown as typeof fetch, calls, state };
}

describe('createMoex (фейковый fetch)', () => {
  it('один запрос на рынок; в URL только SECID и служебные параметры; акции и облигации', async () => {
    const { f, calls } = issFetch();
    const p = createMoex(f);
    const { quotes } = await p.latest(['stock:SBER', 'stock:GAZP', 'bond:OFZ1', 'bond:CNYB', 'crypto:BTC', 'stock:bad id']);
    expect(calls).toHaveLength(2);
    const urls = calls.map((u) => u.pathname + u.search);
    expect(urls[0]).toContain('/markets/shares/securities.json');
    expect(urls[0]).toContain('securities=SBER%2CGAZP');
    expect(urls[0]).toContain('iss.meta=off');
    expect(urls[1]).toContain('/markets/bonds/');
    const by = Object.fromEntries(quotes.map((q) => [q.id, q]));
    expect(by.SBER).toMatchObject({ price: '300', vs: 'RUB' });
    expect(by.OFZ1).toMatchObject({ price: '993.87', vs: 'RUB' }); // 96.1% × 1000 + НКД 32.87
    expect(by.CNYB).toMatchObject({ price: '100.56', vs: 'CNY' });
    expect(Object.keys(by)).not.toContain('BTC');
  });
  it('пакеты по 10', async () => {
    const { f, calls } = issFetch();
    await createMoex(f).latest(Array.from({ length: 23 }, (_, i) => `stock:T${i}`));
    expect(calls).toHaveLength(3);
  });
  it('null-цена → бумага без котировки, остальные пришли', async () => {
    const { f } = issFetch();
    const { quotes } = await createMoex(f).latest(['stock:NOTRADE', 'stock:SBER']);
    expect(quotes.map((q) => q.id)).toEqual(['SBER']);
  });
  it('500 / 429 / сеть / кривой JSON → PriceUnavailable', async () => {
    for (const status of [500, 429]) {
      const { f, state } = issFetch();
      state.status = status;
      await expect(createMoex(f).latest(['stock:SBER'])).rejects.toMatchObject({ status });
    }
    const net = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(createMoex(net).latest(['stock:SBER'])).rejects.toBeInstanceOf(PriceUnavailable);
    const { f, state } = issFetch();
    state.bad = true;
    await expect(createMoex(f).latest(['stock:SBER'])).rejects.toBeInstanceOf(PriceUnavailable);
  });
  it('поиск: только борды белого списка, валюта подставляется', async () => {
    const { f, calls } = issFetch();
    const items = await createMoex(f).search('sb', 'stock');
    expect(items).toEqual([{ secid: 'SBER', isin: 'ISINSBER', name: 'Сбербанк', kind: 'stock', currency: 'RUB', board: 'TQBR' }]);
    expect(calls).toHaveLength(2);
    const bonds = await createMoex(f).search('cn', 'bond');
    expect(bonds[0]).toMatchObject({ secid: 'CNYB', currency: 'CNY' });
  });
});

// ── окружение ──
const JWT_SECRET = 'moex-secret';
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, RUB: 100, CNY: 7 }, asOf: '2026-11-10' }) };
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;
const TABLES = [
  'holdings', 'invites', 'household_members', 'households', 'conversation_state', 'income_entries',
  'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'profiles', 'consents',
  'reminder_log', 'rate_limit', 'audit_log', 'processed_updates', 'users',
];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM price_quotes').run();
  await env.DB.prepare('DELETE FROM price_provider_state').run();
  await env.DB.prepare('DELETE FROM fx_rates').run();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

const apiFor = (moexFetch: typeof fetch | null, prices: PriceProvider | null = null, fxp: FxProvider = fx) => {
  const app = createRouter({ fx: fxp, prices, moex: moexFetch ? createMoex(moexFetch) : null });
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
type Api = ReturnType<typeof apiFor>;

async function user(tgId: number, autoPrices = true, living = 'RUB') {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  const r = scoped(env.DB, uid);
  await r.upsertProfile({
    base_currency: living, income_currency: living, living_currency: living, timezone: 'UTC',
    income_minor: 100000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
  });
  if (autoPrices) await r.patchProfile({ auto_prices_enabled: 1 });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}
const sber = { kind: 'stock', name: 'Сбер', ticker: 'SBER', currency: 'RUB', quantity: '10', invested: '2900' };
const ofz = { kind: 'bond', name: 'ОФЗ', ticker: 'OFZ1', currency: 'RUB', quantity: '2', invested: '1900' };
const post = (api: Api, token: string, body: unknown) => api('/api/tma/holdings', { method: 'POST', token, body });
interface Item {
  id: number; name: string; price: string | null; price_source: string; price_provider: string | null; price_note: string | null;
  effective_price: string | null; value_minor: number; pnl_minor: number | null; valued_at_cost: boolean; auto_note: string | null;
}
interface List {
  items: Item[];
  total: { minor: number | null; missing_rates: string[] };
  auto: { enabled: boolean; available: boolean; sources: { coingecko: boolean; moex: boolean }; attributions: { text: string; url: string }[] };
}
const list = async (api: Api, token: string) => (await (await api('/api/tma/holdings', { token })).json()) as List;

describe('сервис цен: native-ключи, кэш 14 дней, паузы по источникам', () => {
  const T0 = new Date('2026-11-10T12:00:00.000Z');
  it('позиция SBER в USD не вызывает повторный fetch при свежем кэше; ключ — по id', async () => {
    const { f, calls } = issFetch();
    const p = createMoex(f);
    await getQuotes(env.DB, p, [{ id: 'SBER', vs: 'RUB', hint: 'stock:SBER' }], T0);
    expect(calls).toHaveLength(1);
    const r = await getQuotes(env.DB, p, [{ id: 'SBER', vs: 'USD', hint: 'stock:SBER' }], new Date(T0.getTime() + 60_000));
    expect(calls).toHaveLength(1);
    expect(r.map.get('SBER')).toMatchObject({ price: '300', vs: 'RUB' });
  });
  it('сбой → кэш до 14 дней (stale), 15 дней — нет; пауза moex не блокирует coingecko', async () => {
    const { f, state } = issFetch();
    const p = createMoex(f);
    const refs = [{ id: 'SBER', vs: 'RUB', hint: 'stock:SBER' }];
    await getQuotes(env.DB, p, refs, T0);
    state.status = 500;
    const r = await getQuotes(env.DB, p, refs, new Date(T0.getTime() + 13 * 86_400_000));
    expect(r.map.size).toBe(1);
    expect(r.stale).toBe(true);
    const r2 = await getQuotes(env.DB, p, refs, new Date(T0.getTime() + 15 * 86_400_000));
    expect(r2.map.size).toBe(0);
    const st = await env.DB.prepare('SELECT source FROM price_provider_state').all<{ source: string }>();
    expect(st.results.map((x) => x.source)).toEqual(['moex']);
    const cg: PriceProvider = { source: 'coingecko', latest: async () => ({ quotes: [{ id: 'bitcoin', vs: 'USD', price: '1', asOf: T0.toISOString() }] }) };
    const rc = await getQuotes(env.DB, cg, [{ id: 'bitcoin', vs: 'USD' }], T0);
    expect(rc.map.size).toBe(1);
    expect(rc.failed).toBe(false);
  });
});

describe('/api/tma/holdings с биржей', () => {
  it('акция без цены: цена с биржи, P&L, ручной цены нет; облигация с НКД', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { token } = await user(1);
    expect((await post(api, token, sber)).status).toBe(201); // цена не требуется
    expect((await post(api, token, ofz)).status).toBe(201);
    const l = await list(api, token);
    const s = l.items.find((i) => i.name === 'Сбер')!;
    expect(s).toMatchObject({ price_source: 'auto', price_provider: 'moex', effective_price: '300', price_note: null, price: null });
    expect(s.value_minor).toBe(300_000); // 10 × 300 ₽
    expect(s.pnl_minor).toBe(10_000); // 3000 − 2900
    const o = l.items.find((i) => i.name === 'ОФЗ')!;
    expect(o).toMatchObject({ price_provider: 'moex', effective_price: '993.87', price_note: 'with_aci' });
    expect(o.value_minor).toBe(198_774);
    expect(l.auto.sources).toEqual({ coingecko: false, moex: true });
    expect(l.auto.attributions).toEqual([{ text: 'Цены акций и облигаций: Московская биржа, задержка 15 мин', url: 'https://www.moex.com' }]);
    expect(l.total.minor).toBe(300_000 + 198_774);
  });
  it('юаневая облигация в бюджете USD: итог через FX; нет курса CNY → missing_rates', async () => {
    const { f } = issFetch();
    const { token } = await user(2, true, 'USD');
    const api = apiFor(f);
    await post(api, token, { kind: 'bond', name: 'Юань', ticker: 'CNYB', currency: 'CNY', quantity: '10', invested: '1000' });
    const l = await list(api, token);
    expect(l.items[0]).toMatchObject({ price_provider: 'moex', effective_price: '100.56' });
    expect(l.total.minor).toBe(Math.round((1005.6 / 7) * 100));
    await env.DB.prepare('DELETE FROM fx_rates').run();
    const noRate = apiFor(f, null, { latest: async () => ({ perUsd: { USD: 1 }, asOf: '2026-11-10' }) });
    const l2 = await list(noRate, token);
    expect(l2.items).toHaveLength(1);
    expect(l2.total.missing_rates).toEqual(['CNY']);
  });
  it('валюта позиции ≠ валюте бумаги → ccy_mismatch, оценка по цене покупки', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { token } = await user(3);
    await post(api, token, { ...sber, currency: 'USD', invested: '100' });
    const l = await list(api, token);
    expect(l.items[0]).toMatchObject({ price_source: 'manual', auto_note: 'ccy_mismatch', valued_at_cost: true });
  });
  it('бумага не найдена или без торгов → not_found, «по цене покупки»', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { token } = await user(4);
    await post(api, token, { ...sber, ticker: 'ZZZZ' });
    await post(api, token, { ...sber, ticker: 'NOTRADE', name: 'NT' });
    const l = await list(api, token);
    expect(l.items.map((i) => [i.auto_note, i.valued_at_cost])).toEqual([['not_found', true], ['not_found', true]]);
  });
  it('ручная цена не перезаписывается', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { token } = await user(5);
    await post(api, token, { ...sber, price: '250', price_on: '2026-11-01' });
    const l = await list(api, token);
    expect(l.items[0]).toMatchObject({ price_source: 'auto', price: '250', effective_price: '300' });
    const raw = await env.DB.prepare('SELECT price FROM holdings').first<{ price: string }>();
    expect(raw!.price).toMatch(/^enc1:/);
  });
  it('A не видит B: ISS получает только свои коды; A выкл, B вкл → 0 вызовов', async () => {
    const { f, calls } = issFetch();
    const api = apiFor(f);
    const a = await user(6);
    const b = await user(7);
    await post(api, a.token, sber);
    await post(api, b.token, ofz);
    const la = await list(api, a.token);
    expect(la.items.map((i) => i.name)).toEqual(['Сбер']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get('securities')).toBe('SBER');
    expect(calls[0]!.pathname).toContain('/markets/shares/');
    await api('/api/tma/profile', { method: 'PATCH', token: a.token, body: { auto_prices_enabled: false } });
    const before = calls.length;
    expect((await list(api, a.token)).items[0]!.price_source).toBe('manual');
    expect(calls).toHaveLength(before);
    expect((await api('/api/tma/holdings/lookup?kind=stock&q=sb', { token: a.token })).status).toBe(409);
    const idB = (await list(api, b.token)).items[0]!.id;
    expect((await api(`/api/tma/holdings/${idB}`, { method: 'PATCH', token: a.token, body: { note: 'x' } })).status).toBe(404);
    expect((await api(`/api/tma/holdings/${idB}`, { method: 'DELETE', token: a.token })).status).toBe(404);
    const cols = await env.DB.prepare('PRAGMA table_info(price_quotes)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain('user_id');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM holdings WHERE user_id=?').bind(b.uid).first<{ n: number }>();
    expect(Number(n!.n)).toBe(1);
  });
  it('fail-closed: выключатель (moex=null) → 0 запросов, 200; ISS падает → 200; без JWT → 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const off = apiFor(null);
    const { token } = await user(8);
    await post(off, token, sber);
    const l = await list(off, token);
    expect(l.auto.sources.moex).toBe(false);
    expect(l.items[0]).toMatchObject({ price_source: 'manual', valued_at_cost: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    const { f, state } = issFetch();
    state.status = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await apiFor(f)('/api/tma/holdings', { token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as List).items[0]!.auto_note).toBe('no_quote');
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('price_fetch_failed source=moex status=500');
    for (const x of ['SBER', 'Сбер']) expect(logged).not.toContain(x);
    expect((await off('/api/tma/holdings')).status).toBe(401);
  });
  it('идемпотентность и shapeError', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { token } = await user(9);
    const body = { ...sber, client_id: 'c-1' };
    expect((await post(api, token, body)).status).toBe(201);
    const second = await post(api, token, body);
    expect(((await second.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect((await list(api, token)).items).toHaveLength(1);
    expect((await post(api, token, { ...sber, ticker: undefined })).status).toBe(400); // без тикера и без цены
    expect((await post(api, token, { ...sber, ticker: 'RU.X' })).status).toBe(400); // точка — не SECID MOEX
    expect((await post(api, token, { ...ofz, invested: undefined })).status).toBe(201);
  });
});

describe('/api/tma/holdings/lookup', () => {
  it('поиск: только торгуемые белого списка; ничего не пишет; без JWT 401', async () => {
    const { f, calls } = issFetch();
    const api = apiFor(f);
    const { token, uid } = await user(10);
    const res = await api('/api/tma/holdings/lookup?kind=stock&q=sb', { token });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { secid: string; currency: string }[] };
    expect(items.map((i) => i.secid)).toEqual(['SBER']);
    expect(items[0]!.currency).toBe('RUB');
    expect(calls[0]!.searchParams.get('q')).toBe('sb');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM holdings WHERE user_id=?').bind(uid).first<{ n: number }>();
    expect(Number(n!.n)).toBe(0);
    expect((await api('/api/tma/holdings/lookup?kind=stock&q=sb')).status).toBe(401);
  });
  it('валидация: q из 1 символа и с разметкой → 400', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { token } = await user(11);
    for (const q of ['s', encodeURIComponent('<script>')])
      expect((await api(`/api/tma/holdings/lookup?kind=stock&q=${q}`, { token })).status).toBe(400);
    expect((await api('/api/tma/holdings/lookup?kind=crypto&q=sb', { token })).status).toBe(400);
  });
  it('сбой ISS / выключатель → 503; в логе нет строки поиска', async () => {
    const { f, state } = issFetch();
    state.status = 500;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token } = await user(12);
    const r = await apiFor(f)('/api/tma/holdings/lookup?kind=stock&q=sberbank', { token });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('provider_unavailable');
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('sberbank');
    expect((await apiFor(null)('/api/tma/holdings/lookup?kind=stock&q=sb', { token })).status).toBe(503);
  });
});

describe('бот и профиль', () => {
  it('renderInvest: биржа, «с НКД», атрибуция MOEX', async () => {
    const { f } = issFetch();
    const api = apiFor(f);
    const { uid, token } = await user(13);
    await post(api, token, sber);
    await post(api, token, ofz);
    const r = scoped(env.DB, uid);
    const get = async () => ({ perUsd: { USD: 1, RUB: 100 }, asOf: '', stale: false });
    const srcs = makePriceSources(env.DB, { coingecko: null, moex: createMoex(f) }, new Date());
    const v = await portfolioView(r, (await r.getProfile())!, get, '2026-11-10', srcs);
    const html = renderInvest(v);
    expect(html).toContain('Автоцены биржи: 2 поз.');
    expect(html).toContain('с НКД');
    expect(html).toContain('Московская биржа');
    const v2 = await portfolioView(r, (await r.getProfile())!, get, '2026-11-10', null);
    expect(renderInvest(v2)).not.toContain('Московская биржа');
  });
  it('профиль: auto_sources.moex отражает провайдер', async () => {
    const { f } = issFetch();
    const { token } = await user(14);
    const g = (await (await apiFor(f)('/api/tma/profile', { token })).json()) as {
      auto_sources: { moex: boolean };
      auto_prices_available: boolean;
    };
    expect(g).toMatchObject({ auto_prices_available: true, auto_sources: { moex: true } });
  });
});
