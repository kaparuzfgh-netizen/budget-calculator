/**
 * holdings.test.ts — T3a «Инвестиции: ручной портфель»: шифрование at rest,
 * изоляция tenant («A не видит B»), REST Mini App, идемпотентность, лимит,
 * толерантные курсы, export/delete_me, household, каскад целей и бот /invest.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import { FxUnavailable, type FxProvider } from '../src/fx/provider';
import { accessRepo, encryptBackfill, scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { renderInvest } from '../src/bot/invest';
import { portfolioView } from '../src/services/portfolio';
import type { FxResult } from '../src/fx/service';

const JWT_SECRET = 'holdings-secret';
// ZZZ — «нет курса»: провайдер падает на любом батче, где есть ZZZ
const fx: FxProvider = {
  latest: async (ccys) => {
    if (ccys.includes('ZZZ')) throw new FxUnavailable('нет', 'ZZZ');
    return { perUsd: { USD: 1, EUR: 0.5, RUB: 100 }, asOf: '2026-10-27' };
  },
};
const app = createRouter({ fx });
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;

const TABLES = [
  'holdings', 'invites', 'household_members', 'households', 'debt_events', 'debts', 'loan_events', 'loans',
  'conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'commitment_payments', 'commitments',
  'profiles', 'consents', 'reminder_log', 'rate_limit', 'audit_log', 'processed_updates', 'users',
];
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM fx_rates').run();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

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

const crypto1 = { kind: 'crypto', name: 'Биткоин', ticker: 'btc', currency: 'USD', quantity: '0,12345678', price: '30000.5', avg_price: '25000' };
const dep1 = { kind: 'deposit', name: 'Вклад Сбер', currency: 'USD', amount: 1000, rate: 10, opened_on: '2026-01-01' };
const post = (token: string, body: unknown) => api('/api/tma/holdings', { method: 'POST', token, body });

interface Item { id: number; name: string; quantity: string | null; value_minor: number; pnl_minor: number | null; price_stale: boolean; accrued_minor: number | null; currency: string }
interface List {
  items: Item[];
  total: { currency: string; minor: number | null; missing_rates: string[]; fx_stale: boolean };
  allocation: { current: Record<string, number>; targets: Record<string, number> | null };
  disclaimer: string;
}
const list = async (token: string) => (await (await api('/api/tma/holdings', { token })).json()) as List;

describe('шифрование at rest', () => {
  it('сырой SELECT — enc1:, round-trip через repo; invest_targets тоже', async () => {
    const { uid, token } = await user(1);
    expect((await post(token, crypto1)).status).toBe(201);
    expect((await post(token, dep1)).status).toBe(201);
    const raw = await env.DB.prepare('SELECT name, ticker, quantity, avg_price, price, amount_minor, rate, note FROM holdings ORDER BY id').all<Record<string, unknown>>();
    const [btc, dep] = raw.results;
    for (const k of ['name', 'ticker', 'quantity', 'avg_price', 'price']) expect(String(btc![k]), k).toMatch(/^enc1:/);
    for (const k of ['name', 'amount_minor', 'rate']) expect(String(dep![k]), k).toMatch(/^enc1:/);
    const row = (await scoped(env.DB, uid).listHoldings()).results[0]!;
    expect(row.quantity).toBe('0.12345678'); // 8-й знак не потерян
    expect(row.ticker).toBe('BTC');

    await api('/api/tma/profile', { method: 'PATCH', token, body: { invest_targets: { deposit: 60, crypto: 40 } } });
    const p = await env.DB.prepare('SELECT invest_targets FROM profiles WHERE user_id=?').bind(uid).first<{ invest_targets: string }>();
    expect(p!.invest_targets).toMatch(/^enc1:/);
  });

  it('encryptBackfill шифрует legacy-plaintext строку holdings', async () => {
    const { uid } = await user(2);
    await env.DB.prepare(
      "INSERT INTO holdings (user_id, kind, name, currency, quantity, price) VALUES (?, 'stock', 'Plain', 'USD', '2', '10')",
    ).bind(uid).run();
    expect(await encryptBackfill(env.DB)).toBeGreaterThan(0);
    const raw = await env.DB.prepare('SELECT name, quantity, price FROM holdings').first<Record<string, string>>();
    expect(raw!.name).toMatch(/^enc1:/);
    expect(raw!.quantity).toMatch(/^enc1:/);
    expect((await scoped(env.DB, uid).listHoldings()).results[0]!.name).toBe('Plain');
  });
});

describe('/api/tma/holdings — доступ и валидация', () => {
  it('401 без токена и с битым JWT; 403 не onboarded', async () => {
    for (const [m, p] of [['GET', '/api/tma/holdings'], ['POST', '/api/tma/holdings'], ['PATCH', '/api/tma/holdings/1'], ['DELETE', '/api/tma/holdings/1']] as const) {
      expect((await api(p, { method: m, body: {} })).status, `${m} ${p}`).toBe(401);
      expect((await api(p, { method: m, body: {}, token: 'bad.jwt.token' })).status).toBe(401);
    }
    const { token } = await user(3, false);
    expect((await api('/api/tma/holdings', { token })).status).toBe(403);
  });

  it('JSON-число в quantity/price отклоняется; вид определяет обязательные поля; user_id игнорируется', async () => {
    const { uid, token } = await user(4);
    const other = await user(5);
    expect((await post(token, { ...crypto1, quantity: 0.5 })).status).toBe(400);
    expect((await post(token, { ...crypto1, price: 12 })).status).toBe(400);
    expect((await post(token, { ...crypto1, quantity: '1e3' })).status).toBe(400);
    expect((await post(token, { ...crypto1, quantity: '0.123456789' })).status).toBe(400);
    expect((await post(token, { kind: 'crypto', name: 'X', currency: 'USD' })).status).toBe(400); // нет qty/price
    expect((await post(token, { kind: 'deposit', name: 'X', currency: 'USD' })).status).toBe(400); // нет суммы
    expect((await post(token, { ...dep1, quantity: '1', price: '1' })).status).toBe(400); // лишнее для вклада
    expect((await post(token, { ...crypto1, quantity: '999999999999', price: '999999999999' })).status).toBe(400); // TOO_LARGE
    expect((await post(token, { ...dep1, opened_on: '2999-01-01' })).status).toBe(400);
    const ok = await post(token, { ...dep1, user_id: other.uid });
    expect(ok.status).toBe(201);
    expect((await scoped(env.DB, uid).listHoldings()).results).toHaveLength(1);
    expect((await scoped(env.DB, other.uid).listHoldings()).results).toHaveLength(0);
  });

  it('оценка: qty×price, P&L, вклад «≈ начислено», пометка устаревшей цены', async () => {
    const { token } = await user(6);
    await post(token, { ...crypto1, quantity: '0.1', price: '30000.5', avg_price: '20000' });
    await post(token, dep1);
    const id = ((await (await post(token, { kind: 'stock', name: 'Old', currency: 'USD', quantity: '2', price: '10' })).json()) as { id: number }).id;
    await env.DB.prepare("UPDATE holdings SET price_on='2020-01-01' WHERE id=?").bind(id).run();
    const l = await list(token);
    const btc = l.items.find((i) => i.name === 'Биткоин')!;
    expect(btc.value_minor).toBe(300005);
    expect(btc.pnl_minor).toBe(100005); // 0.1 × (30000.5 − 20000)
    expect(l.items.find((i) => i.name === 'Вклад Сбер')!.accrued_minor).toBeGreaterThan(0);
    expect(l.items.find((i) => i.name === 'Old')!.price_stale).toBe(true);
    expect(l.total.minor).toBe(300005 + 100000 + 2000);
    expect(l.disclaimer).toContain('не инвестиционная рекомендация');
  });

  it('PATCH пересчитывает; новая цена ставит price_on=сегодня; DELETE удаляет', async () => {
    const { token } = await user(7);
    const id = ((await (await post(token, crypto1)).json()) as { id: number }).id;
    expect((await api(`/api/tma/holdings/${id}`, { method: 'PATCH', token, body: { price: '40000' } })).status).toBe(200);
    expect((await api(`/api/tma/holdings/${id}`, { method: 'PATCH', token, body: { amount: 5 } })).status).toBe(400); // сумма не для crypto
    expect((await api(`/api/tma/holdings/${id}`, { method: 'PATCH', token, body: {} })).status).toBe(400);
    expect((await list(token)).items[0]!.value_minor).toBe(493827); // 0.12345678 × 40000 = 4938.2712 → 4938.27
    expect((await api(`/api/tma/holdings/${id}`, { method: 'DELETE', token })).status).toBe(200);
    expect((await list(token)).items).toHaveLength(0);
    expect((await api(`/api/tma/holdings/${id}`, { method: 'DELETE', token })).status).toBe(404);
  });
});

describe('изоляция tenant: A не видит B', () => {
  it('GET/PATCH/DELETE по чужому id → 404, строка B не меняется; repo-уровень', async () => {
    const a = await user(10);
    const b = await user(11);
    const idB = ((await (await post(b.token, crypto1)).json()) as { id: number }).id;
    expect((await list(a.token)).items).toHaveLength(0);
    expect((await api(`/api/tma/holdings/${idB}`, { method: 'PATCH', token: a.token, body: { name: 'Взлом' } })).status).toBe(404);
    expect((await api(`/api/tma/holdings/${idB}`, { method: 'DELETE', token: a.token })).status).toBe(404);
    expect((await list(b.token)).items[0]!.name).toBe('Биткоин');
    const ra = scoped(env.DB, a.uid);
    expect(await ra.getHolding(idB)).toBeNull();
    expect((await ra.patchHolding(idB, { name: 'x' })).meta.changes).toBe(0);
    expect((await ra.deleteHolding(idB)).meta.changes).toBe(0);
    expect(await ra.countHoldings()).toBe(0);
  });
});

describe('идемпотентность и лимит', () => {
  it('один client_id → один ряд, повтор 200 duplicate; у A и B — независимые', async () => {
    const a = await user(20);
    const b = await user(21);
    const r1 = await post(a.token, { ...crypto1, client_id: 'c1' });
    expect(r1.status).toBe(201);
    const id = ((await r1.json()) as { id: number }).id;
    const r2 = await post(a.token, { ...crypto1, client_id: 'c1' });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ id, duplicate: true });
    expect((await list(a.token)).items).toHaveLength(1);
    expect((await post(b.token, { ...crypto1, client_id: 'c1' })).status).toBe(201);
    expect((await list(b.token)).items).toHaveLength(1);
  });

  it('51-я позиция → 409 limit', async () => {
    const { uid, token } = await user(22);
    const r = scoped(env.DB, uid);
    for (let i = 0; i < 50; i++)
      await r.addHolding({ kind: 'other', name: `p${i}`, ticker: null, currency: 'USD', quantity: null, avg_price: null, price: null, price_on: null, amount_minor: 100, rate: null, opened_on: null, matures_on: null, note: null });
    const res = await post(token, dep1);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('limit');
  });
});

describe('курсы: толерантный режим', () => {
  it('валюта без курса — в missing_rates, итог по остальным (200)', async () => {
    const { token } = await user(30);
    await post(token, { kind: 'deposit', name: 'USD', currency: 'USD', amount: 100 });
    await post(token, { kind: 'deposit', name: 'EUR', currency: 'EUR', amount: 50 });
    await post(token, { kind: 'deposit', name: 'ZZZ', currency: 'ZZZ', amount: 10 });
    const r = await api('/api/tma/holdings', { token });
    expect(r.status).toBe(200);
    const l = (await r.json()) as List;
    expect(l.items).toHaveLength(3);
    expect(l.total.missing_rates).toEqual(['ZZZ']);
    expect(l.total.minor).toBe(10000 + 10000); // 50 EUR при EUR 0.5/USD = 100 USD
  });

  it('устаревший кэш при падении провайдера → fx_stale', async () => {
    const { uid } = await user(31);
    const r = scoped(env.DB, uid);
    await r.addHolding({ kind: 'deposit', name: 'E', ticker: null, currency: 'EUR', quantity: null, avg_price: null, price: null, price_on: null, amount_minor: 5000, rate: null, opened_on: null, matures_on: null, note: null });
    await env.DB.prepare("INSERT OR REPLACE INTO fx_rates (currency, per_usd, as_of, fetched_at) VALUES ('EUR', 0.5, '2026-01-01', '2020-01-01T00:00:00.000Z')").run();
    const p = (await r.getProfile())!;
    const get = async (c: string[]): Promise<FxResult> => {
      if (!c.includes('EUR')) return { perUsd: { USD: 1 }, asOf: '', stale: false };
      return { perUsd: { USD: 1, EUR: 0.5 }, asOf: '2026-01-01', stale: true };
    };
    const v = await portfolioView(r, p, get, '2026-10-27');
    expect(v.total.fx_stale).toBe(true);
    expect(v.total.minor).toBe(10000);
  });
});

describe('цели и каскад бонуса', () => {
  it('цели: сумма ≠ 100 → 400; null сбрасывает', async () => {
    const { token } = await user(40);
    const patch = (b: unknown) => api('/api/tma/profile', { method: 'PATCH', token, body: b });
    expect((await patch({ invest_targets: { deposit: 50 } })).status).toBe(400);
    expect((await patch({ invest_targets: { gold: 100 } })).status).toBe(400);
    expect((await patch({ invest_targets: { deposit: 60, crypto: 40 } })).status).toBe(200);
    const pr = (await (await api('/api/tma/profile', { token })).json()) as { invest_targets: Record<string, number> | null };
    expect(pr.invest_targets).toEqual({ deposit: 60, crypto: 40 });
    expect((await patch({ invest_targets: null })).status).toBe(200);
    expect(((await (await api('/api/tma/profile', { token })).json()) as { invest_targets: unknown }).invest_targets).toBeNull();
  });

  it('plan: без целей dca_split пуст; с целями — по видам, сумма = dca_usd_minor (±1)', async () => {
    const { token } = await user(41);
    await api('/api/tma/profile', { method: 'PATCH', token, body: { bonus_prepay_share: 0.3, bonus_dca_share: 0.5 } });
    type Plan = { bonus: { dca_usd_minor: number; dca_split: { kind: string; usd_minor: number }[] } | null };
    const url = '/api/tma/plan?income=3000&currency=USD';
    const p0 = (await (await api(url, { token })).json()) as Plan;
    expect(p0.bonus!.dca_usd_minor).toBeGreaterThan(0);
    expect(p0.bonus!.dca_split).toEqual([]);
    await api('/api/tma/profile', { method: 'PATCH', token, body: { invest_targets: { deposit: 60, crypto: 40 } } });
    const p1 = (await (await api(url, { token })).json()) as Plan;
    expect(p1.bonus!.dca_split.map((s) => s.kind).sort()).toEqual(['crypto', 'deposit']);
    const sum = p1.bonus!.dca_split.reduce((s, x) => s + x.usd_minor, 0);
    expect(Math.abs(sum - p1.bonus!.dca_usd_minor)).toBeLessThanOrEqual(1);
    expect(p1.bonus!.dca_usd_minor).toBe(p0.bonus!.dca_usd_minor);
  });
});

describe('export / delete_me / household', () => {
  it('export: schema_version 7, holdings без source_key; delete_me стирает только свои', async () => {
    const a = await user(50);
    const b = await user(51);
    await post(a.token, { ...crypto1, client_id: 'x1' });
    await post(b.token, dep1);
    const ex = (await (await api('/api/tma/export', { token: a.token })).json()) as { schema_version: number; holdings: Record<string, unknown>[] };
    expect(ex.schema_version).toBe(7);
    expect(ex.holdings).toHaveLength(1);
    expect(ex.holdings[0]!.name).toBe('Биткоин');
    expect('source_key' in ex.holdings[0]!).toBe(false);
    await scoped(env.DB, a.uid).deleteAllUserData();
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM holdings WHERE user_id=?').bind(a.uid).first<{ n: number }>())!.n).toBe(0);
    expect((await scoped(env.DB, b.uid).listHoldings()).results).toHaveLength(1);
  });

  it('партнёр по общему бюджету не видит позиций и сумм', async () => {
    const a = await user(60);
    const b = await user(61);
    await post(a.token, { kind: 'deposit', name: 'СекретныйВклад', currency: 'USD', amount: 777123 });
    const acc = accessRepo(env.DB);
    const hh = await acc.createHousehold(a.uid, 60_000_00, 'USD', 1_153_846);
    await acc.createHouseholdInvite('hh-hash', a.uid, hh, '2999-01-01T00:00:00.000Z');
    expect((await acc.redeemHouseholdInvite('hh-hash', b.uid, '2026-10-15T12:00:00.000Z')).redeemed).toBe(true);
    const r = await api('/api/tma/household', { token: b.token });
    expect(r.status).toBe(200);
    const txt = await r.text();
    expect(txt).not.toContain('СекретныйВклад');
    expect(txt).not.toContain('777123');
    expect(txt).not.toContain('77712300');
    expect((await list(b.token)).items).toHaveLength(0);
  });
});

describe('бот: экран INVEST', () => {
  it('renderInvest: итог, доли, цели, пометка «нет курса», дисклеймер', async () => {
    const { uid, token } = await user(70);
    await post(token, dep1);
    await post(token, crypto1);
    await post(token, { kind: 'deposit', name: 'Z', currency: 'ZZZ', amount: 5 });
    await api('/api/tma/profile', { method: 'PATCH', token, body: { invest_targets: { deposit: 50, crypto: 50 } } });
    const r = scoped(env.DB, uid);
    const get = (c: string[]) => fx.latest(c.filter((x) => x !== 'ZZZ')).then((x) => ({ ...x, stale: false }) as FxResult).catch(() => { throw new FxUnavailable('x', c[0]); });
    const v = await portfolioView(r, (await r.getProfile())!, get, '2026-10-27');
    const txt = renderInvest(v);
    expect(txt).toContain('Итого');
    expect(txt).toContain('Доли:');
    expect(txt).toContain('Цели:');
    expect(txt).toContain('ZZZ');
    expect(txt).toContain('не инвестиционная рекомендация');
    expect(txt).not.toContain('Биткоин'); // названия позиций в бот не выводим
    expect(renderInvest({ ...v, items: [] })).toContain('Позиций пока нет');
  });
});
