/**
 * trades.test.ts — T3d1 «Журнал покупок/продаж»: шифрование, «A не видит и не пишет
 * сделки B», идемпотентность, CAS-инвариант «кэш = свёртка журнала», ленивая начальная
 * запись, блокировка ручной правки, закрытие/скрытие, валидация, удаление, export,
 * логи, бот. (Household: набор ключей householdSummary зафиксирован в household.test.ts —
 * сделок и результатов там нет.)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import type { PriceProvider } from '../src/prices/provider';
import { encryptBackfill, scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { foldTrades } from '../src/domain/trades';
import { renderInvest } from '../src/bot/invest';
import { portfolioView } from '../src/services/portfolio';
import { addTrade } from '../src/services/trades';

const JWT_SECRET = 'trades-secret';
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 0.5 }, asOf: '2026-10-27' }) };
const latestSpy = vi.fn(async (_ids: string[]) => ({ quotes: [] as never[] }));
const prices: PriceProvider = { source: 'coingecko', latest: (ids) => latestSpy(ids) };
const app = createRouter({ fx, prices });
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's', COINGECKO_API_KEY: 'k' }) as typeof env;

const TABLES = [
  'holding_trades', 'holdings', 'invites', 'household_members', 'households', 'conversation_state', 'income_entries',
  'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'profiles', 'consents', 'reminder_log',
  'rate_limit', 'audit_log', 'processed_updates', 'users',
];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  latestSpy.mockClear();
  await env.DB.prepare('DELETE FROM price_quotes').run();
  await env.DB.prepare('DELETE FROM price_provider_state').run();
  await env.DB.prepare('DELETE FROM fx_rates').run();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

const api = (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) =>
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

async function user(tgId: number, onboarded = true) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  if (onboarded)
    await scoped(env.DB, uid).upsertProfile({
      base_currency: 'USD', income_currency: 'USD', living_currency: 'USD', timezone: 'UTC',
      income_minor: 100000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
      bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
    });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}

const btc = { kind: 'crypto', name: 'Биткоин', ticker: 'BTC', currency: 'USD', quantity: '1', invested: '30000', price: '40000', price_on: '2026-01-01' };
const dep = { kind: 'deposit', name: 'Вклад', currency: 'USD', amount: 1000 };
const mk = async (token: string, body: unknown = btc) => ((await (await api('/api/tma/holdings', { method: 'POST', token, body })).json()) as { id: number }).id;
const trade = (token: string, hid: number, body: unknown) => api(`/api/tma/holdings/${hid}/trades`, { method: 'POST', token, body });
const del = (token: string, hid: number, tid: number) => api(`/api/tma/holdings/${hid}/trades/${tid}`, { method: 'DELETE', token });
const sell = (q: string, a: string, extra: object = {}) => ({ side: 'sell', quantity: q, amount: a, ...extra });
const buy = (q: string, a: string, extra: object = {}) => ({ side: 'buy', quantity: q, amount: a, ...extra });
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
interface TV {
  holding: { quantity: string | null; invested: string | null; avg_cost: string | null; realized_minor: number | null; closed_on: string | null };
  items: { id: number; side: string; initial: boolean; realized_minor: number | null; amount: string; unit_price: string | null }[];
}
const view = async (token: string, hid: number) => (await (await api(`/api/tma/holdings/${hid}/trades`, { token })).json()) as TV;
interface List {
  items: { id: number; value_minor: number; trades_count: number; realized_minor: number | null; closed_on: string | null; hidden: boolean; avg_cost: string | null }[];
  total: { minor: number | null };
  allocation: { current: Record<string, number> };
}
const list = async (token: string) => (await (await api('/api/tma/holdings', { token })).json()) as List;

/** Инвариант: кэш позиции = свёртка журнала. */
async function expectCacheMatchesJournal(uid: number, hid: number) {
  const r = scoped(env.DB, uid);
  const h = (await r.getHolding(hid))!;
  const rows = await r.listTrades(hid);
  const f = foldTrades(rows.map((t) => ({ id: t.id, side: t.side, quantity: t.quantity, amount: t.amount, traded_on: t.traded_on, is_initial: t.is_initial === 1 })));
  expect({ q: h.quantity, i: h.invested, r: h.realized_minor, c: h.closed_on }).toEqual({ q: f.state.quantity, i: f.state.invested, r: f.state.realizedMinor, c: f.state.closedOn });
}

describe('шифрование', () => {
  it('quantity/amount/note и holdings.realized_minor — enc1:; backfill шифрует legacy', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    expect((await trade(a.token, hid, sell('0.5', '30000', { note: 'секрет' }))).status).toBe(201);
    const raw = await env.DB.prepare('SELECT quantity, amount, note FROM holding_trades ORDER BY id').all<Record<string, string>>();
    expect(raw.results).toHaveLength(2);
    for (const row of raw.results) for (const k of ['quantity', 'amount']) expect(row[k], k).toMatch(/^enc1:/);
    expect(raw.results[1]!.note).toMatch(/^enc1:/);
    const h = await env.DB.prepare('SELECT realized_minor FROM holdings').first<{ realized_minor: string }>();
    expect(String(h!.realized_minor)).toMatch(/^enc1:/);
    await env.DB.prepare("INSERT INTO holding_trades (user_id, holding_id, side, quantity, amount, traded_on) VALUES (?, ?, 'buy', '1', '2', '2026-01-01')").bind(a.uid, hid).run();
    expect(await encryptBackfill(env.DB)).toBeGreaterThan(0);
    const legacy = await env.DB.prepare('SELECT quantity, amount FROM holding_trades ORDER BY id DESC LIMIT 1').first<Record<string, string>>();
    expect(legacy!.quantity).toMatch(/^enc1:/);
    expect(legacy!.amount).toMatch(/^enc1:/);
  });
});

describe('A не видит и не пишет сделки B', () => {
  it('404 на всё чужое; строки B не меняются', async () => {
    const a = await user(1);
    const b = await user(2);
    const ha = await mk(a.token);
    const hb = await mk(b.token);
    expect((await trade(b.token, hb, sell('0.5', '30000'))).status).toBe(201);
    const sellB = (await scoped(env.DB, b.uid).listTrades(hb)).find((t) => t.side === 'sell')!;
    const snap = async () =>
      JSON.stringify([
        await env.DB.prepare('SELECT * FROM holdings WHERE id=?').bind(hb).first(),
        (await env.DB.prepare('SELECT * FROM holding_trades WHERE holding_id=? ORDER BY id').bind(hb).all()).results,
      ]);
    const before = await snap();

    expect((await api(`/api/tma/holdings/${hb}/trades`, { token: a.token })).status).toBe(404);
    expect((await trade(a.token, hb, buy('1', '1'))).status).toBe(404);
    expect((await del(a.token, ha, sellB.id)).status).toBe(404);
    expect((await del(a.token, hb, sellB.id)).status).toBe(404);
    expect(await snap()).toBe(before);

    const rep = await scoped(env.DB, a.uid).commitTrades(
      hb,
      1,
      { inserts: [{ side: 'buy', is_initial: false, quantity: '1', amount: '1', traded_on: '2026-01-01', note: null, source_key: null }], deleteIds: [sellB.id] },
      { quantity: '9', invested: '9', realizedMinor: null, closedOn: null },
    );
    expect(rep.applied).toBe(false);
    expect(await snap()).toBe(before);

    const la = await list(a.token);
    expect(la.items.map((i) => i.id)).toEqual([ha]);
    expect(la.items[0]!.trades_count).toBe(0);
  });
});

describe('идемпотентность и гонки', () => {
  it('один client_id — одна сделка; у A и B независимы', async () => {
    const a = await user(1);
    const b = await user(2);
    const ha = await mk(a.token);
    const hb = await mk(b.token);
    const r1 = await trade(a.token, ha, buy('1', '100', { client_id: 'c1' }));
    const r2 = await trade(a.token, ha, buy('1', '100', { client_id: 'c1' }));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect((await view(a.token, ha)).holding.quantity).toBe('2');
    expect((await trade(b.token, hb, buy('1', '100', { client_id: 'c1' }))).status).toBe(201);
    expect((await view(b.token, hb)).holding.quantity).toBe('2');
  });
  it('параллельные сделки: применены или 409, кэш = свёртка журнала', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const rs = await Promise.all([trade(a.token, hid, buy('1', '10')), trade(a.token, hid, buy('2', '30')), trade(a.token, hid, sell('0.5', '50'))]);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    await expectCacheMatchesJournal(a.uid, hid);
  });
  it('серия случайных покупок/продаж/удалений сохраняет инвариант', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 40; i++) {
      const op = rnd(4);
      const day = `2026-0${1 + rnd(9)}-1${rnd(9)}`;
      if (op === 0) await trade(a.token, hid, buy(`${1 + rnd(5)}.${rnd(99) + 1}`, `${100 + rnd(900)}`, { traded_on: day }));
      else if (op === 1) await trade(a.token, hid, sell(`0.${1 + rnd(9)}`, `${10 + rnd(500)}`, { traded_on: day }));
      else {
        const items = (await view(a.token, hid)).items.filter((x) => !x.initial);
        if (items.length) await del(a.token, hid, items[rnd(items.length)]!.id);
      }
      await expectCacheMatchesJournal(a.uid, hid);
    }
  });
});

describe('ленивая начальная запись', () => {
  it('T3a-позиция (avg_price): начальная amount=30000, продажа 0.5/20000 → +500000', async () => {
    const a = await user(1);
    const hid = await mk(a.token, { ...btc, invested: undefined, avg_price: '30000' });
    expect((await trade(a.token, hid, sell('0.5', '20000'))).status).toBe(201);
    const v = await view(a.token, hid);
    expect(v.items).toHaveLength(2);
    expect(v.items[0]).toMatchObject({ initial: true, amount: '30000' });
    expect(v.items[1]!.realized_minor).toBe(500_000);
    expect(v.holding).toMatchObject({ quantity: '0.5', invested: '15000', realized_minor: 500_000 });
  });
  it('без invested и avg_price → 409 invested_required, 0 строк', async () => {
    const a = await user(1);
    const hid = await mk(a.token, { ...btc, invested: undefined });
    const r = await trade(a.token, hid, sell('0.5', '1'));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('invested_required');
    expect(await scoped(env.DB, a.uid).countTrades(hid)).toBe(0);
  });
  it('удаление единственной реальной сделки возвращает ручной режим', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const t = (await (await trade(a.token, hid, buy('1', '100'))).json()) as { id: number };
    expect((await api(`/api/tma/holdings/${hid}`, { method: 'PATCH', token: a.token, body: { quantity: '9' } })).status).toBe(409);
    expect((await del(a.token, hid, t.id)).status).toBe(200);
    expect(await scoped(env.DB, a.uid).countTrades(hid)).toBe(0);
    expect((await view(a.token, hid)).holding).toMatchObject({ quantity: '1', invested: '30000', realized_minor: null });
    expect((await api(`/api/tma/holdings/${hid}`, { method: 'PATCH', token: a.token, body: { quantity: '9' } })).status).toBe(200);
  });
  it('начальную нельзя удалить при других сделках', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    await trade(a.token, hid, buy('1', '100'));
    await trade(a.token, hid, buy('1', '100'));
    const init = (await view(a.token, hid)).items.find((x) => x.initial)!;
    const r = await del(a.token, hid, init.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('initial_locked');
  });
  it('удаление покупки, на которой держалась продажа → 409 oversell', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const t = (await (await trade(a.token, hid, buy('1', '100'))).json()) as { id: number };
    await trade(a.token, hid, sell('2', '500'));
    const r = await del(a.token, hid, t.id);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('oversell');
    await expectCacheMatchesJournal(a.uid, hid);
  });
});

describe('блокировка, закрытие, скрытие', () => {
  it('trades_locked для quantity/invested/avg_price/currency; name/price/note — 200', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    await trade(a.token, hid, buy('1', '100'));
    for (const body of [{ quantity: '5' }, { invested: '5' }, { avg_price: '5' }, { currency: 'EUR' }]) {
      const r = await api(`/api/tma/holdings/${hid}`, { method: 'PATCH', token: a.token, body });
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(await code(r)).toBe('trades_locked');
    }
    for (const body of [{ name: 'Новое' }, { price: '41000' }, { note: 'x' }])
      expect((await api(`/api/tma/holdings/${hid}`, { method: 'PATCH', token: a.token, body })).status).toBe(200);
  });
  it('продажа всего → закрыта, стоимость 0, не в итоге; цены не запрашиваются; скрытие; покупка снова открывает', async () => {
    const a = await user(1);
    await scoped(env.DB, a.uid).patchProfile({ auto_prices_enabled: 1 });
    const hid = await mk(a.token);
    expect((await trade(a.token, hid, sell('1', '45000', { traded_on: '2026-02-02' }))).status).toBe(201);
    latestSpy.mockClear();
    const l = await list(a.token);
    expect(latestSpy).not.toHaveBeenCalled();
    expect(l.items[0]).toMatchObject({ value_minor: 0, closed_on: '2026-02-02', realized_minor: 1_500_000, trades_count: 2, hidden: false });
    expect(l.total.minor).toBe(0);
    expect(l.allocation.current).toEqual({});
    expect((await api(`/api/tma/holdings/${hid}`, { method: 'PATCH', token: a.token, body: { hidden: true } })).status).toBe(200);
    expect((await list(a.token)).items[0]!.hidden).toBe(true);
    expect((await trade(a.token, hid, buy('2', '100'))).status).toBe(201);
    expect((await list(a.token)).items[0]).toMatchObject({ closed_on: null, hidden: false, realized_minor: 1_500_000 });
    const r = await api(`/api/tma/holdings/${hid}`, { method: 'PATCH', token: a.token, body: { hidden: true } });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('not_closed');
  });
});

describe('валидация и fail-closed', () => {
  it('401/403/400/409', async () => {
    const a = await user(1);
    const n = await user(3, false);
    const hid = await mk(a.token);
    expect((await api(`/api/tma/holdings/${hid}/trades`)).status).toBe(401);
    expect((await trade(n.token, hid, buy('1', '1'))).status).toBe(403);
    for (const body of [
      buy('1', '1', { traded_on: '2999-01-01' }),
      { side: 'buy', quantity: 1, amount: '1' },
      { side: 'gift', quantity: '1', amount: '1' },
      buy('1', '1', { user_id: 5 }),
      buy('1', '1', { holding_id: 5 }),
      buy('0', '1'),
    ])
      expect((await trade(a.token, hid, body)).status, JSON.stringify(body)).toBe(400);
    const d = await mk(a.token, dep);
    const r = await trade(a.token, d, buy('1', '1'));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('trades_unsupported');
  });
  it('oversell → 409, ничего не записано', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const r = await trade(a.token, hid, sell('1.00000001', '1'));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('oversell');
    expect(await scoped(env.DB, a.uid).countTrades(hid)).toBe(0);
  });
  it('201-я сделка → 409 limit', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const repo = scoped(env.DB, a.uid);
    await trade(a.token, hid, buy('1', '1'));
    const h = (await repo.getHolding(hid))!;
    const have = await repo.countTrades(hid);
    const ins = Array.from({ length: 200 - have }, () => ({ side: 'buy' as const, is_initial: false, quantity: '1', amount: '1', traded_on: '2026-03-01', note: null, source_key: null }));
    const state = { quantity: '300', invested: '300', realizedMinor: null, closedOn: null };
    expect((await repo.commitTrades(hid, h.trade_rev, { inserts: ins, deleteIds: [] }, state)).applied).toBe(true);
    const r = await trade(a.token, hid, buy('1', '1'));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('limit');
  });
  it('логи ошибок сделок не содержат сумм и заметок', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    await trade(a.token, hid, sell('777.5', '12345', { note: 'ТАЙНА' }));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/777|12345|ТАЙНА/);
  });
});

describe('удаление и экспорт', () => {
  it('DELETE позиции убирает сделки; deleteAllUserData трогает только своё', async () => {
    const a = await user(1);
    const b = await user(2);
    const ha = await mk(a.token);
    const hb = await mk(b.token);
    await trade(a.token, ha, buy('1', '1'));
    await trade(b.token, hb, buy('1', '1'));
    expect((await api(`/api/tma/holdings/${ha}`, { method: 'DELETE', token: a.token })).status).toBe(200);
    expect(await scoped(env.DB, a.uid).countTrades(ha)).toBe(0);
    const ha2 = await mk(a.token);
    await trade(a.token, ha2, buy('1', '1'));
    await scoped(env.DB, a.uid).deleteAllUserData();
    const n = async (u: number) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM holding_trades WHERE user_id=?').bind(u).first<{ n: number }>())!.n;
    expect(await n(a.uid)).toBe(0);
    expect(await n(b.uid)).toBe(2);
  });
  it('export: schema_version 10, holding_trades без source_key, holdings без trade_rev', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    await trade(a.token, hid, sell('0.5', '30000', { client_id: 'x' }));
    const ex = (await (await api('/api/tma/export', { token: a.token })).json()) as {
      schema_version: number;
      holding_trades: Record<string, unknown>[];
      holdings: Record<string, unknown>[];
    };
    expect(ex.schema_version).toBe(10);
    expect(ex.holding_trades).toHaveLength(2);
    expect('source_key' in ex.holding_trades[0]!).toBe(false);
    expect(ex.holding_trades[1]!.quantity).toBe('0.5');
    expect('trade_rev' in ex.holdings[0]!).toBe(false);
    for (const k of ['realized_minor', 'closed_on', 'hidden']) expect(ex.holdings[0]).toHaveProperty(k);
  });
});

describe('бот и сервис', () => {
  it('renderInvest: «позиций» без закрытых, «Закрытых: M»', async () => {
    const a = await user(1);
    const h1 = await mk(a.token);
    await mk(a.token, { ...btc, name: 'Второй', ticker: 'ETH' });
    await trade(a.token, h1, sell('1', '45000'));
    const repo = scoped(env.DB, a.uid);
    const p = (await repo.getProfile())!;
    const v = await portfolioView(repo, p, async () => ({ perUsd: { USD: 1 }, asOf: '', stale: false }), '2026-11-01');
    const html = renderInvest(v);
    expect(html).toContain('позиций: 1');
    expect(html).toContain('Закрытых: 1');
  });
  it('инкремент не читает журнал при дате ≥ последней; задним числом — читает', async () => {
    const a = await user(1);
    const hid = await mk(a.token);
    const repo = scoped(env.DB, a.uid);
    const t = { side: 'buy' as const, quantity: '1', amount: '1', note: null };
    await addTrade(repo, hid, { ...t, traded_on: '2026-02-01' });
    const spy = vi.spyOn(repo, 'listTrades');
    await addTrade(repo, hid, { ...t, traded_on: '2026-02-01' });
    expect(spy).not.toHaveBeenCalled();
    await addTrade(repo, hid, { ...t, traded_on: '2026-01-01' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
