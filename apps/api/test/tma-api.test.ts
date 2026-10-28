/** tma-api.test.ts — REST API Mini App (веха E): паритет бота, валидация, изоляция, идемпотентность. */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { todayInTz } from '../src/bot/parse';

const JWT_SECRET = 'tma-api-secret';
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 0.9 }, asOf: '2026-10-27' }) };
const app = createRouter({ fx });
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const t of ['conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'profiles', 'consents', 'reminder_log', 'rate_limit', 'audit_log', 'processed_updates', 'invites', 'users'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
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
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD', income_currency: 'USD', living_currency: 'USD', timezone: 'UTC',
    income_minor: 100000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: onboarded ? 'x' : null,
  });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}

describe('/api/tma/* — контракт', () => {
  it('401 без токена на каждом роуте', async () => {
    for (const [m, p] of [
      ['GET', '/api/tma/plan'], ['GET', '/api/tma/week'], ['GET', '/api/tma/expenses'],
      ['POST', '/api/tma/expenses'], ['GET', '/api/tma/income'], ['POST', '/api/tma/income'],
      ['GET', '/api/tma/profile'], ['PATCH', '/api/tma/profile'],
      ['GET', '/api/tma/commitments'], ['POST', '/api/tma/commitments'],
      ['GET', '/api/tma/commitments/1/payments'], ['POST', '/api/tma/commitments/1/payments'],
      ['PATCH', '/api/tma/commitment-payments/1'], ['DELETE', '/api/tma/commitment-payments/1'],
    ] as const) expect((await api(p, { method: m, body: {} })).status, `${m} ${p}`).toBe(401);
  });

  it('week: те же числа, что и бот (spent/week, burn rate, days left)', async () => {
    const { uid, token } = await user(900001);
    await scoped(env.DB, uid).addExpense({
      spent_on: todayInTz('UTC', new Date()), amount_minor: 32000, currency: 'USD', note: 'кофе', source: 'manual', source_key: 'x1',
    });
    const o = (await (await api('/api/tma/week', { token })).json()) as { week_spent_minor: number; week_budget_minor: number; month_cap_minor: number };
    expect(o.week_spent_minor).toBe(32000);
    expect(o.week_budget_minor).toBe(1384615);
    expect(o.month_cap_minor).toBe(6000000);
  });

  it('plan: источник дохода аргумент > факт > типичный; PATCH профиля меняет план', async () => {
    const { token } = await user(900002);
    const p1 = (await (await api('/api/tma/plan', { token })).json()) as { income_source: string; income_minor: number };
    expect(p1.income_source).toBe('typical');
    expect(p1.income_minor).toBe(100000);
    const p2 = (await (await api('/api/tma/plan?income=5000&currency=USD', { token })).json()) as { income_source: string; income_minor: number };
    expect(p2.income_source).toBe('override');
    expect(p2.income_minor).toBe(500000);
    expect((await api('/api/tma/plan?income=-5', { token })).status).toBe(400);
    expect((await api('/api/tma/plan?income=5&currency=XX1', { token })).status).toBe(400);
    // PATCH living_cap → weekly_budget пересчитан ×12/52
    const patch = await api('/api/tma/profile', { method: 'PATCH', token, body: { living_cap: 5200 } });
    const pj = (await patch.json()) as { weekly_budget_minor: number };
    expect(pj.weekly_budget_minor).toBe(120000); // 520000*12/52
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: { timezone: 'bad/tz' } })).status).toBe(400);
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: {} })).status).toBe(400);
  });

  it('expenses CRUD + client_id идемпотентность + изоляция', async () => {
    const A = await user(900003);
    const B = await user(900004);
    const post = () =>
      api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 320, currency: 'USD', note: 'кафе', client_id: 'c1' } });
    const r1 = await post();
    expect(r1.status).toBe(201);
    const { id } = (await r1.json()) as { id: number };
    const r2 = await post(); // тот же client_id → дубликат, не вторая строка
    expect((await r2.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
    expect((await scoped(env.DB, A.uid).listExpenses()).results).toHaveLength(1);
    // валидация
    expect((await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: -1 } })).status).toBe(400);
    expect((await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 0 } })).status).toBe(400);
    expect((await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 1e10 } })).status).toBe(400);
    // GET недели содержит запись
    const list = (await (await api('/api/tma/expenses', { token: A.token })).json()) as { expenses: { id: number; note: string }[] };
    // «кафе» автоматчится в категорию и вырезается из заметки — проверяем только id
    expect(list.expenses.some((e) => e.id === id)).toBe(true);
    // PATCH своей — ок; PATCH чужой → 404
    expect((await api(`/api/tma/expenses/${id}`, { method: 'PATCH', token: A.token, body: { amount: 400 } })).status).toBe(200);
    expect((await scoped(env.DB, A.uid).getExpense(id))!.amount_minor).toBe(40000);
    expect((await api(`/api/tma/expenses/${id}`, { method: 'PATCH', token: B.token, body: { amount: 1 } })).status).toBe(404);
    expect((await api(`/api/tma/expenses/${id}`, { method: 'DELETE', token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/expenses/${id}`, { method: 'DELETE', token: A.token })).status).toBe(200);
    expect((await scoped(env.DB, A.uid).listExpenses()).results).toHaveLength(0);
  });

  it('income: add/list/delete; итог месяца в валюте профиля; чужой id → 404', async () => {
    const A = await user(900005);
    const B = await user(900006);
    const r = await api('/api/tma/income', { method: 'POST', token: A.token, body: { amount: 5000, currency: 'USD', client_id: 'i9' } });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: number };
    const hub = (await (await api('/api/tma/income', { token: A.token })).json()) as { total_minor: number; entries: { id: number }[] };
    expect(hub.total_minor).toBe(500000);
    expect(hub.entries).toHaveLength(1);
    expect((await api(`/api/tma/income/${id}`, { method: 'DELETE', token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/income/${id}`, { method: 'DELETE', token: A.token })).status).toBe(200);
  });

  it('commitments: CRUD + лимит 30 + name в patch + изоляция', async () => {
    const A = await user(900007);
    const B = await user(900008);
    const r = await api('/api/tma/commitments', {
      method: 'POST', token: A.token, body: { name: 'Аренда', amount: 700, currency: 'USD', due_day: 1 },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: number };
    expect((await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'X', amount: 1, due_day: 32 } })).status).toBe(400);
    // лимит: дозаполняем до 30
    for (let i = 0; i < 29; i++)
      await scoped(env.DB, A.uid).addCommitment({ name: `c${i}`, amount_minor: 1, currency: 'USD', due_day: null });
    expect((await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'Y', amount: 1 } })).status).toBe(400);
    // patch: имя + выключение
    expect((await api(`/api/tma/commitments/${id}`, { method: 'PATCH', token: A.token, body: { name: 'Аренда2', active: false } })).status).toBe(200);
    const row = (await scoped(env.DB, A.uid).getCommitment(id))!;
    expect(row.name).toBe('Аренда2');
    expect(row.active).toBe(0);
    expect((await api(`/api/tma/commitments/${id}`, { method: 'PATCH', token: B.token, body: { amount: 1 } })).status).toBe(404);
    expect((await api(`/api/tma/commitments/${id}`, { method: 'DELETE', token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/commitments/${id}`, { method: 'DELETE', token: A.token })).status).toBe(200);
  });

  it('журнал оплат: POST дедуп по client_id, paid_this_month в списке, PATCH/DELETE, изоляция 404', async () => {
    const A = await user(900020);
    const B = await user(900021);
    const r = await api('/api/tma/commitments', {
      method: 'POST', token: A.token, body: { name: 'Квартплата', amount: 500, currency: 'USD', due_day: 5 },
    });
    const cid = ((await r.json()) as { id: number }).id;

    // POST без суммы — берётся сумма платежа; повтор по client_id — дубликат
    const pay = () =>
      api(`/api/tma/commitments/${cid}/payments`, { method: 'POST', token: A.token, body: { client_id: 'cp1' } });
    expect((await pay()).status).toBe(201);
    expect((await (await pay()).json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
    const pays = (await (await api(`/api/tma/commitments/${cid}/payments`, { token: A.token })).json()) as {
      payments: { id: number; amount_minor: number; paid_on: string; source: string }[];
    };
    expect(pays.payments).toHaveLength(1);
    expect(pays.payments[0]!.amount_minor).toBe(50000);
    expect(pays.payments[0]!.source).toBe('manual');
    const pid = pays.payments[0]!.id;

    // paid_this_month в списке платежей
    const list = (await (await api('/api/tma/commitments', { token: A.token })).json()) as {
      commitments: { id: number; paid_this_month: boolean; last_paid_on: string | null }[];
    };
    expect(list.commitments[0]!.paid_this_month).toBe(true);
    expect(list.commitments[0]!.last_paid_on).toBe(pays.payments[0]!.paid_on);

    // PATCH/DELETE своей записи
    expect(
      (await api(`/api/tma/commitment-payments/${pid}`, {
        method: 'PATCH', token: A.token, body: { amount: 450, paid_on: '2026-10-01' },
      })).status,
    ).toBe(200);
    expect(
      (await api(`/api/tma/commitment-payments/${pid}`, { method: 'PATCH', token: A.token, body: {} })).status,
    ).toBe(400);
    const row = (await scoped(env.DB, A.uid).getCommitmentPayment(pid))!;
    expect(row.amount_minor).toBe(45000);
    expect(row.paid_on).toBe('2026-10-01');

    // изоляция: чужие id → 404 везде
    for (const [m, p, body] of [
      ['GET', `/api/tma/commitments/${cid}/payments`, undefined],
      ['POST', `/api/tma/commitments/${cid}/payments`, { amount: 1 }],
      ['PATCH', `/api/tma/commitment-payments/${pid}`, { amount: 1 }],
      ['DELETE', `/api/tma/commitment-payments/${pid}`, undefined],
    ] as const)
      expect((await api(p, { method: m, token: B.token, body })).status, `${m} ${p}`).toBe(404);
    // запись у чужого платежа не создаётся (EXISTS-гейт в repo)
    expect(
      (await api(`/api/tma/commitments/${cid}/payments`, {
        method: 'POST', token: B.token, body: { amount: 1 },
      })).status,
    ).toBe(404);

    expect((await api(`/api/tma/commitment-payments/${pid}`, { method: 'DELETE', token: A.token })).status).toBe(200);
    expect((await api(`/api/tma/commitment-payments/${pid}`, { method: 'DELETE', token: A.token })).status).toBe(404);
    // после удаления оплаты paid_this_month снова false
    const list2 = (await (await api('/api/tma/commitments', { token: A.token })).json()) as {
      commitments: { paid_this_month: boolean }[];
    };
    expect(list2.commitments[0]!.paid_this_month).toBe(false);
  });
});
