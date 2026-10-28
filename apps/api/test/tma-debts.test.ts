/**
 * tma-debts.test.ts — REST кредитов и займов Mini App (веха H3):
 * replay-контракт с ботом, валидация zod, client_id-идемпотентность,
 * правки/удаления событий пересчитывают остаток, изоляция тенантов.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';

const JWT_SECRET = 'tma-debts-secret';
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, RUB: 0.011 }, asOf: '2026-10-27' }) };
const app = createRouter({ fx });
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const t of [
    'debt_events', 'debts', 'loan_events', 'loans',
    'conversation_state', 'income_entries', 'weekly_expenses', 'commitment_payments', 'commitments',
    'profiles', 'consents', 'reminder_log', 'rate_limit', 'audit_log',
    'processed_updates', 'invites', 'users',
  ]) await env.DB.prepare(`DELETE FROM ${t}`).run();
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

async function user(tgId: number) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD', income_currency: 'USD', living_currency: 'USD', timezone: 'UTC',
    income_minor: 100000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
  });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}

/** аннуитет под 12% годовых на остаток 100k и платёж 10k — replay-эталон бота. */
const mkDebt = async (token: string) => {
  const r = await api('/api/tma/debts', {
    method: 'POST', token,
    body: { name: 'Ипотека', amount: 100000, currency: 'RUB', rate: 12, payment: 11000, due_day: 5 },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: number }).id;
};

interface DebtCard {
  id: number;
  balance_minor: number;
  payment_minor: number;
  months_left: number;
  events: { id: number; kind: string; amount_minor: number; event_on: string; mode: string | null }[];
}
const debtCard = async (token: string, id: number) =>
  (await (await api(`/api/tma/debts/${id}`, { token })).json()) as DebtCard;

describe('/api/tma/debts* — кредиты', () => {
  it('401 без токена на всех новых роутах', async () => {
    for (const [m, p] of [
      ['GET', '/api/tma/debts'], ['POST', '/api/tma/debts'],
      ['GET', '/api/tma/debts/1'], ['PATCH', '/api/tma/debts/1'], ['DELETE', '/api/tma/debts/1'],
      ['GET', '/api/tma/debts/1/prepay-preview'], ['POST', '/api/tma/debts/1/events'],
      ['PATCH', '/api/tma/debt-events/1'], ['DELETE', '/api/tma/debt-events/1'],
      ['GET', '/api/tma/loans'], ['POST', '/api/tma/loans'],
      ['GET', '/api/tma/loans/1'], ['PATCH', '/api/tma/loans/1'], ['DELETE', '/api/tma/loans/1'],
      ['POST', '/api/tma/loans/1/close'], ['POST', '/api/tma/loans/1/events'],
      ['PATCH', '/api/tma/loan-events/1'], ['DELETE', '/api/tma/loan-events/1'],
    ] as const) expect((await api(p, { method: m, body: {} })).status, `${m} ${p}`).toBe(401);
  });

  it('создание → список с replay-состоянием; валидация полей', async () => {
    const { token } = await user(910001);
    await mkDebt(token);
    expect((await api('/api/tma/debts', { method: 'POST', token, body: { name: 'X', amount: -1, currency: 'RUB', rate: 1, payment: 1 } })).status).toBe(400);
    expect((await api('/api/tma/debts', { method: 'POST', token, body: { name: 'X', amount: 1, currency: 'RU', rate: 101, payment: 1 } })).status).toBe(400);
    const list = (await (await api('/api/tma/debts', { token })).json()) as {
      debts: { id: number; balance_minor: number; payment_minor: number }[];
      total_usd_minor: number | null;
    };
    expect(list.debts).toHaveLength(1);
    expect(list.debts[0]!.balance_minor).toBe(10000000);
    expect(list.debts[0]!.payment_minor).toBe(1100000);
    expect(list.total_usd_minor).toBeGreaterThan(0); // RUB→USD через мок fx
  });

  it('события: платёж/ЧДП с режимом/сверка + client_id идемпотентность + replay', async () => {
    const { uid, token } = await user(910002);
    const id = await mkDebt(token);

    // платёж: дубль по client_id → одна строка, баланс пересчитан replay'ем
    const pay = () =>
      api(`/api/tma/debts/${id}/events`, {
        method: 'POST', token, body: { kind: 'payment', amount: 11000, client_id: 'p1' },
      });
    expect((await pay()).status).toBe(201);
    expect((await (await pay()).json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
    let card = await debtCard(token, id);
    expect(card.events).toHaveLength(1);
    expect(card.events[0]!.kind).toBe('payment');
    expect(card.balance_minor).toBeLessThan(10000000); // платёж погасил часть тела

    // ЧДП «платёж↓» — mode сохраняется, платёж уменьшается
    const pp = await api(`/api/tma/debts/${id}/events`, {
      method: 'POST', token, body: { kind: 'prepay', amount: 20000, mode: 'reduce_payment', event_on: '2026-10-20' },
    });
    expect(pp.status).toBe(201);
    card = await debtCard(token, id);
    const prepay = card.events.find((e) => e.kind === 'prepay')!;
    expect(prepay.mode).toBe('reduce_payment');
    expect(card.payment_minor).toBeLessThan(1100000);

    // ЧДП «срок↓» — платёж не меняется
    const before = card.payment_minor;
    const pt = await api(`/api/tma/debts/${id}/events`, {
      method: 'POST', token, body: { kind: 'prepay', amount: 5000, mode: 'reduce_term' },
    });
    expect(pt.status).toBe(201);
    card = await debtCard(token, id);
    expect(card.events.find((e) => e.mode === 'reduce_term')).toBeTruthy();
    expect(card.payment_minor).toBe(before);

    // сверка — остаток становится ровно указанным
    expect(
      (await api(`/api/tma/debts/${id}/events`, {
        method: 'POST', token, body: { kind: 'reconcile', amount: 60000 },
      })).status,
    ).toBe(201);
    card = await debtCard(token, id);
    expect(card.balance_minor).toBe(6000000);

    // prepay больше остатка → 400; несуществующий долг → 404
    expect((await api(`/api/tma/debts/${id}/events`, { method: 'POST', token, body: { kind: 'prepay', amount: 999999 } })).status).toBe(400);
    expect((await api('/api/tma/debts/9999/events', { method: 'POST', token, body: { kind: 'payment', amount: 1 } })).status).toBe(404);
    expect((await scoped(env.DB, uid).listDebtEvents(id)).results).toHaveLength(4);
  });

  it('правка/удаление события пересчитывают остаток; mode на не-prepay → 400', async () => {
    const { token } = await user(910003);
    const id = await mkDebt(token);
    const ev = await api(`/api/tma/debts/${id}/events`, {
      method: 'POST', token, body: { kind: 'payment', amount: 11000 },
    });
    const evId = ((await ev.json()) as { id: number }).id;
    expect((await api(`/api/tma/debt-events/${evId}`, { method: 'PATCH', token, body: { mode: 'reduce_term' } })).status).toBe(400);
    expect((await api(`/api/tma/debt-events/${evId}`, { method: 'PATCH', token, body: { amount: 5000, event_on: '2026-10-01' } })).status).toBe(200);
    let card = await debtCard(token, id);
    expect(card.events[0]!.amount_minor).toBe(500000);
    expect(card.events[0]!.event_on).toBe('2026-10-01');
    // удаление события → остаток вернулся к начальному
    expect((await api(`/api/tma/debt-events/${evId}`, { method: 'DELETE', token })).status).toBe(200);
    card = await debtCard(token, id);
    expect(card.events).toHaveLength(0);
    expect(card.balance_minor).toBe(10000000);
    expect((await api(`/api/tma/debt-events/${evId}`, { method: 'DELETE', token })).status).toBe(404);
  });

  it('patch параметров кредита + превью ЧДП + удаление', async () => {
    const { token } = await user(910004);
    const id = await mkDebt(token);
    expect((await api(`/api/tma/debts/${id}`, { method: 'PATCH', token, body: { rate: 15, payment: 12000, due_day: null } })).status).toBe(200);
    const card = await debtCard(token, id);
    expect(card.payment_minor).toBe(1200000);

    const pv = (await (await api(`/api/tma/debts/${id}/prepay-preview?amount=20000`, { token })).json()) as {
      balance_after_minor: number;
      payment_after_minor: number;
      months_saved: number;
    };
    expect(pv.balance_after_minor).toBe(8000000);
    expect(pv.payment_after_minor).toBeLessThan(1200000);
    expect(pv.months_saved).toBeGreaterThan(0);
    expect((await api(`/api/tma/debts/${id}/prepay-preview?amount=0`, { token })).status).toBe(400);

    expect((await api(`/api/tma/debts/${id}`, { method: 'DELETE', token })).status).toBe(200);
    expect((await api(`/api/tma/debts/${id}`, { token })).status).toBe(404);
  });

  it('изоляция: чужой кредит и его события недоступны (404)', async () => {
    const A = await user(910005);
    const B = await user(910006);
    const id = await mkDebt(A.token);
    await api(`/api/tma/debts/${id}/events`, { method: 'POST', token: A.token, body: { kind: 'payment', amount: 11000 } });
    const evId = (await debtCard(A.token, id)).events[0]!.id;
    expect((await api(`/api/tma/debts/${id}`, { token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/debts/${id}`, { method: 'PATCH', token: B.token, body: { rate: 1 } })).status).toBe(404);
    expect((await api(`/api/tma/debts/${id}`, { method: 'DELETE', token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/debts/${id}/events`, { method: 'POST', token: B.token, body: { kind: 'payment', amount: 1 } })).status).toBe(404);
    expect((await api(`/api/tma/debt-events/${evId}`, { method: 'PATCH', token: B.token, body: { amount: 1 } })).status).toBe(404);
    expect((await api(`/api/tma/debt-events/${evId}`, { method: 'DELETE', token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/debts/${id}/prepay-preview?amount=100`, { token: B.token })).status).toBe(404);
  });
});

describe('/api/tma/loans* — займы', () => {
  const mkLoan = async (token: string, direction: 'owe' | 'owed' = 'owe') => {
    const r = await api('/api/tma/loans', {
      method: 'POST', token,
      body: { counterparty: 'Вася', direction, amount: 300, currency: 'USD', due_on: '2026-11-15', note: 'записка' },
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { id: number }).id;
  };
  const loanCard = async (token: string, id: number) =>
    (await (await api(`/api/tma/loans/${id}`, { token })).json()) as {
      remaining_minor: number; status: string; closed: boolean; due_on: string | null;
      events: { id: number; amount_minor: number; event_on: string }[];
    };

  it('создание → секции owe/owed; возврат с client_id; закрытие', async () => {
    const { token } = await user(910007);
    const oweId = await mkLoan(token, 'owe');
    const owedId = await mkLoan(token, 'owed');
    const list = (await (await api('/api/tma/loans', { token })).json()) as {
      owe: { id: number; remaining_minor: number }[];
      owed: { id: number }[];
      owe_usd_minor: number | null;
    };
    expect(list.owe.map((x) => x.id)).toEqual([oweId]);
    expect(list.owed.map((x) => x.id)).toEqual([owedId]);
    expect(list.owe_usd_minor).toBe(30000);

    // возврат: дубль по client_id; сверх остатка → 400
    const rep = () => api(`/api/tma/loans/${oweId}/events`, { method: 'POST', token, body: { amount: 100, client_id: 'r1' } });
    expect((await rep()).status).toBe(201);
    expect((await (await rep()).json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
    let card = await loanCard(token, oweId);
    expect(card.remaining_minor).toBe(20000);
    expect(card.status).toBe('partial');
    expect((await api(`/api/tma/loans/${oweId}/events`, { method: 'POST', token, body: { amount: 500 } })).status).toBe(400);

    // полный возврат → closed по replay; события на закрытом → 400
    expect((await api(`/api/tma/loans/${oweId}/events`, { method: 'POST', token, body: { amount: 200 } })).status).toBe(201);
    card = await loanCard(token, oweId);
    expect(card.status).toBe('closed');
    expect((await api(`/api/tma/loans/${oweId}/events`, { method: 'POST', token, body: { amount: 1 } })).status).toBe(400);
  });

  it('due_on/note patch, ручное закрытие (идемпотентно), удаление', async () => {
    const { token } = await user(910008);
    const id = await mkLoan(token);
    expect((await api(`/api/tma/loans/${id}`, { method: 'PATCH', token, body: { due_on: null, note: 'передоговорили' } })).status).toBe(200);
    let card = await loanCard(token, id);
    expect(card.due_on).toBeNull();
    expect((await api(`/api/tma/loans/${id}/close`, { method: 'POST', token })).status).toBe(200);
    expect((await api(`/api/tma/loans/${id}/close`, { method: 'POST', token })).status).toBe(200);
    card = await loanCard(token, id);
    expect(card.closed).toBe(true);
    expect(card.remaining_minor).toBe(0); // остаток прощён
    expect((await api(`/api/tma/loans/${id}`, { method: 'DELETE', token })).status).toBe(200);
    expect((await api(`/api/tma/loans/${id}`, { token })).status).toBe(404);
  });

  it('правка/удаление возврата пересчитывают остаток; изоляция', async () => {
    const A = await user(910009);
    const B = await user(910010);
    const id = await mkLoan(A.token);
    await api(`/api/tma/loans/${id}/events`, { method: 'POST', token: A.token, body: { amount: 100, event_on: '2026-10-20' } });
    const evId = (await loanCard(A.token, id)).events[0]!.id;
    expect((await api(`/api/tma/loan-events/${evId}`, { method: 'PATCH', token: A.token, body: { amount: 50, event_on: '2026-10-21' } })).status).toBe(200);
    let card = await loanCard(A.token, id);
    expect(card.remaining_minor).toBe(25000);
    expect(card.events[0]!.event_on).toBe('2026-10-21');
    // изоляция: заём и его события чужому → 404
    for (const [m, p, body] of [
      ['GET', `/api/tma/loans/${id}`, undefined], ['PATCH', `/api/tma/loans/${id}`, { due_on: null }],
      ['DELETE', `/api/tma/loans/${id}`, undefined], ['POST', `/api/tma/loans/${id}/close`, {}],
      ['POST', `/api/tma/loans/${id}/events`, { amount: 1 }],
      ['PATCH', `/api/tma/loan-events/${evId}`, { amount: 1 }], ['DELETE', `/api/tma/loan-events/${evId}`, undefined],
    ] as const)
      expect((await api(p, { method: m, token: B.token, body })).status, `${m} ${p}`).toBe(404);
    expect((await api(`/api/tma/loan-events/${evId}`, { method: 'DELETE', token: A.token })).status).toBe(200);
    card = await loanCard(A.token, id);
    expect(card.remaining_minor).toBe(30000);
    expect(card.status).toBe('open');
  });
});

describe('P2-3: идемпотентное создание по client_id', () => {
  const debtBody = { name: 'Кредит', amount: 5000, currency: 'RUB', rate: 10, payment: 500 };

  it('POST /debts: повтор с тем же client_id → 200 + тот же id; другой ключ → новый (201)', async () => {
    const { uid, token } = await user(910011);
    const repo = scoped(env.DB, uid);
    const body = { ...debtBody, client_id: 'dd1' };
    const r1 = await api('/api/tma/debts', { method: 'POST', token, body });
    expect(r1.status).toBe(201);
    const id1 = ((await r1.json()) as { id: number }).id;
    const r2 = await api('/api/tma/debts', { method: 'POST', token, body });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ id: id1, duplicate: true });
    const r3 = await api('/api/tma/debts', { method: 'POST', token, body: { ...debtBody, client_id: 'dd2' } });
    expect(r3.status).toBe(201);
    expect(((await r3.json()) as { id: number }).id).not.toBe(id1);
    const list = (await (await api('/api/tma/debts', { token })).json()) as { debts: unknown[] };
    expect(list.debts).toHaveLength(2);
    // source_key реально лежит в строке: ключ 'tma:<client_id>' находит долг
    expect((await repo.findDebtByKey('tma:dd1'))?.id).toBe(id1);
  });

  it('POST /debts: бот-созданный долг (без client_id) не конфликтует с ключами NULL', async () => {
    const { uid, token } = await user(910012);
    // долг как из бота — source_key NULL; два NULL не конфликтуют (partial UNIQUE)
    const repo = scoped(env.DB, uid);
    await repo.addDebt({ name: 'Бот', currency: 'USD', rate: 0.1, frequency: 'monthly', initial_balance_minor: 1000, initial_payment_minor: 100, epoch: '2026-01-01', due_day: null });
    await repo.addDebt({ name: 'Бот2', currency: 'USD', rate: 0.1, frequency: 'monthly', initial_balance_minor: 1000, initial_payment_minor: 100, epoch: '2026-01-01', due_day: null });
    const r = await api('/api/tma/debts', { method: 'POST', token, body: { ...debtBody } });
    expect(r.status).toBe(201); // и REST без client_id тоже NULL — свободно
  });

  it('POST /loans: повтор с тем же client_id → 200 + тот же id; другой ключ → новый (201)', async () => {
    const { token } = await user(910013);
    const body = { counterparty: 'Вася', direction: 'owe', amount: 300, currency: 'USD', client_id: 'll1' };
    const r1 = await api('/api/tma/loans', { method: 'POST', token, body });
    expect(r1.status).toBe(201);
    const id1 = ((await r1.json()) as { id: number }).id;
    const r2 = await api('/api/tma/loans', { method: 'POST', token, body });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ id: id1, duplicate: true });
    const r3 = await api('/api/tma/loans', { method: 'POST', token, body: { counterparty: 'Вася', direction: 'owe', amount: 300, currency: 'USD', client_id: 'll2' } });
    expect(r3.status).toBe(201);
    expect(((await r3.json()) as { id: number }).id).not.toBe(id1);
    // заём другого юзера с тем же client_id — свой id (ключ в скоупе user_id)
    const B = await user(910014);
    const rB = await api('/api/tma/loans', { method: 'POST', token: B.token, body });
    expect(rB.status).toBe(201);
    expect(((await rB.json()) as { id: number }).id).not.toBe(id1);
  });
});

describe('P2-2: верхние границы сущностей', () => {
  it('долги: 20-й активный создаётся, 21-й → 400; неактивный не считается; дубль на лимите → 200', async () => {
    const { uid, token } = await user(910015);
    const repo = scoped(env.DB, uid);
    for (let i = 0; i < 19; i++)
      await repo.addDebt({ name: `D${i}`, currency: 'USD', rate: 0.1, frequency: 'monthly', initial_balance_minor: 1000, initial_payment_minor: 100, epoch: '2026-01-01', due_day: null });
    // неактивный не занимает лимит
    const inact = Number((await repo.addDebt({ name: 'old', currency: 'USD', rate: 0, frequency: 'monthly', initial_balance_minor: 1, initial_payment_minor: 1, epoch: '2026-01-01', due_day: null })).meta.last_row_id);
    await repo.patchDebt(inact, { active: 0 });
    const body = { name: 'Хвост', amount: 100, currency: 'USD', rate: 1, payment: 10, client_id: 'cap1' };
    const r20 = await api('/api/tma/debts', { method: 'POST', token, body });
    expect(r20.status).toBe(201); // 20-й активный — ок
    const r21 = await api('/api/tma/debts', { method: 'POST', token, body: { name: 'Лишний', amount: 1, currency: 'USD', rate: 1, payment: 1 } });
    expect(r21.status).toBe(400);
    expect(((await r21.json()) as { error: { message: string } }).error.message).toContain('20');
    // повтор 20-го с тем же client_id — дедуп раньше лимита → 200
    const rdup = await api('/api/tma/debts', { method: 'POST', token, body });
    expect(rdup.status).toBe(200);
    expect(await rdup.json()).toMatchObject({ duplicate: true });
  });

  it('займы: 100-й открытый создаётся, 101-й → 400; закрытый не считается', async () => {
    const { uid, token } = await user(910016);
    // 100 открытых займов одним INSERT … SELECT — дёшево для сетапа
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 99)
       INSERT INTO loans (user_id, counterparty, direction, amount_minor, currency)
       SELECT ?, 'L' || n, 'owe', 100, 'USD' FROM seq`,
    ).bind(uid).run();
    const repo = scoped(env.DB, uid);
    // закрытый не занимает лимит
    const closedId = Number((await repo.addLoan({ counterparty: 'Закрыт', direction: 'owe', amount_minor: 1, currency: 'USD', due_on: null, note: null })).meta.last_row_id);
    await repo.closeLoan(closedId);
    const r100 = await api('/api/tma/loans', { method: 'POST', token, body: { counterparty: 'Сотый', direction: 'owe', amount: 1, currency: 'USD' } });
    expect(r100.status).toBe(201); // 100-й открытый — ок
    const r101 = await api('/api/tma/loans', { method: 'POST', token, body: { counterparty: 'Лишний', direction: 'owed', amount: 1, currency: 'USD' } });
    expect(r101.status).toBe(400);
    expect(((await r101.json()) as { error: { message: string } }).error.message).toContain('100');
  });
});
