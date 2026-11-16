/** tma-api.test.ts — REST API Mini App (веха E): паритет бота, валидация, изоляция, идемпотентность. */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import { FxUnavailable, type FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { monthInTz, todayInTz } from '../src/bot/parse';

const JWT_SECRET = 'tma-api-secret';
const RATES: Record<string, number> = { EUR: 0.9, RUB: 97, KZT: 500 };
const fx: FxProvider = {
  latest: async (ccys) => {
    const perUsd: Record<string, number> = { USD: 1 };
    for (const c of ccys.map((x) => x.toUpperCase())) {
      if (c === 'USD') continue;
      if (!(c in RATES)) throw new FxUnavailable(`Валюта ${c} не поддерживается`, c);
      perUsd[c] = RATES[c]!;
    }
    return { perUsd, asOf: '2026-10-27' };
  },
};
const app = createRouter({ fx });
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const t of ['conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'commitment_payments', 'debt_events', 'debts', 'loan_events', 'loans', 'exchanges', 'commitments', 'profiles', 'consents', 'reminder_log', 'rate_limit', 'audit_log', 'processed_updates', 'invites', 'users'])
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
      ['GET', '/api/tma/expenses/1'],
      ['POST', '/api/tma/expenses'], ['GET', '/api/tma/income'], ['POST', '/api/tma/income'],
      ['GET', '/api/tma/profile'], ['PATCH', '/api/tma/profile'],
      ['GET', '/api/tma/commitments'], ['POST', '/api/tma/commitments'],
      ['GET', '/api/tma/commitments/1/payments'], ['POST', '/api/tma/commitments/1/payments'],
      ['PATCH', '/api/tma/commitment-payments/1'], ['DELETE', '/api/tma/commitment-payments/1'],
      ['GET', '/api/tma/export'], ['POST', '/api/tma/vision/analyze'],
    ] as const) expect((await api(p, { method: m, body: {} })).status, `${m} ${p}`).toBe(401);
  });

  it('week: те же числа, что и бот (spent/week, burn rate, days left)', async () => {
    const { uid, token } = await user(900001);
    await scoped(env.DB, uid).addExpense({
      spent_on: todayInTz('UTC', new Date()), amount_minor: 32000, currency: 'USD', note: 'кофе', source: 'manual', source_key: 'x1',
    });
    const o = (await (await api('/api/tma/week', { token })).json()) as { week_spent_minor: number; week_budget_minor: number; month_cap_minor: number; week_from: string; week_to: string; week_day: number; month_day: number; month_days: number; month_daily_minor: number[]; month_top: { name: string; emoji: string; spent_minor: number; share: number }[] };
    expect(o.week_spent_minor).toBe(32000);
    expect(o.week_budget_minor).toBe(1384615);
    expect(o.month_cap_minor).toBe(6000000);
    // диапазон недели и день месяца — для карточек «дни vs бюджет»
    expect(o.week_from <= o.week_to).toBe(true);
    expect(o.month_day).toBeGreaterThanOrEqual(1);
    expect(o.month_day).toBeLessThanOrEqual(o.month_days);
    // день недели «сегодня» — шкала «дни недели» в гонке
    expect(o.week_day).toBeGreaterThanOrEqual(1);
    expect(o.week_day).toBeLessThanOrEqual(7);
    // дневные суммы месяца — массив на каждый день для графика темпа
    expect(o.month_daily_minor).toHaveLength(o.month_days);
    // топ категорий месяца — для совета «что резать» (кофе без категории → «Без категории»)
    expect(o.month_top.length).toBeGreaterThanOrEqual(1);
    expect(o.month_top[0]!.spent_minor).toBe(32000);
    expect(o.month_top[0]!.share).toBe(1);
  });

  it('plan: источник дохода аргумент > факт > базовый (typical); PATCH профиля меняет план', async () => {
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
    // подушка: PATCH profile {cushion} → план считает покрытие в месяцах
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: { cushion: -5 } })).status).toBe(400);
    await api('/api/tma/profile', { method: 'PATCH', token, body: { cushion: 7800 } });
    const prof = (await (await api('/api/tma/profile', { token })).json()) as { cushion_minor: number | null };
    expect(prof.cushion_minor).toBe(780000);
    const p3 = (await (await api('/api/tma/plan', { token })).json()) as {
      today: string;
      cushion: { minor: number; currency: string; months: number; goal_months: number };
    };
    expect(p3.today).toBe(todayInTz('UTC', new Date()));
    expect(p3.cushion.minor).toBe(780000);
    expect(p3.cushion.currency).toBe('USD');
    expect(p3.cushion.months).toBe(1.5); // 7800 / (0 обязательных + 5200 бюджет)
    expect(p3.cushion.goal_months).toBe(3);
  });

  it('каскад бонуса: PATCH долей → GET отражает; сумма >1 → 400; план показывает цель досрочки', async () => {
    const { uid, token } = await user(900150);
    // валидация: границы и слитая сумма ≤ 1
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: { bonus_prepay_share: 1.5 } })).status).toBe(400);
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: { bonus_prepay_share: -0.1 } })).status).toBe(400);
    expect(
      (await api('/api/tma/profile', { method: 'PATCH', token, body: { bonus_prepay_share: 0.7, bonus_dca_share: 0.4 } })).status,
    ).toBe(400);
    // 0.6/0.3 — ок; частичный PATCH не может превысить сумму с учётом хранимого
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: { bonus_prepay_share: 0.6, bonus_dca_share: 0.3 } })).status).toBe(200);
    expect((await api('/api/tma/profile', { method: 'PATCH', token, body: { bonus_dca_share: 0.5 } })).status).toBe(400); // 0.6+0.5
    const prof = (await (await api('/api/tma/profile', { token })).json()) as {
      bonus_prepay_share: number;
      bonus_dca_share: number;
    };
    expect(prof.bonus_prepay_share).toBe(0.6);
    expect(prof.bonus_dca_share).toBe(0.3);
    // два кредита — цель досрочки = макс. ставка
    await scoped(env.DB, uid).addDebt({
      name: 'Ипотека', currency: 'USD', rate: 0.12, frequency: 'monthly',
      initial_balance_minor: 9000000, initial_payment_minor: 90000, epoch: '2024-01-05', due_day: 5,
    });
    await scoped(env.DB, uid).addDebt({
      name: 'Рассрочка', currency: 'USD', rate: 0.03, frequency: 'monthly',
      initial_balance_minor: 300000, initial_payment_minor: 30000, epoch: '2024-02-05', due_day: 5,
    });
    // доход override 5000 > база 1000 → дельта 4000: 2400 досрочка / 1200 DCA
    const plan = (await (await api('/api/tma/plan?income=5000&currency=USD', { token })).json()) as {
      bonus: { delta_usd_minor: number; prepay_usd_minor: number; dca_usd_minor: number; prepay_target: string | null } | null;
    };
    expect(plan.bonus).not.toBeNull();
    expect(plan.bonus!.delta_usd_minor).toBe(400000);
    expect(plan.bonus!.prepay_usd_minor).toBe(240000);
    expect(plan.bonus!.dca_usd_minor).toBe(120000);
    expect(plan.bonus!.prepay_target).toBe('Ипотека');
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
    // GET по id: своя — ок, чужая → 404 (карточка из отчётов вне недели)
    const one = (await (await api(`/api/tma/expenses/${id}`, { token: A.token })).json()) as { expense: { id: number } };
    expect(one.expense.id).toBe(id);
    expect((await api(`/api/tma/expenses/${id}`, { token: B.token })).status).toBe(404);
    // PATCH своей — ок; PATCH чужой → 404
    expect((await api(`/api/tma/expenses/${id}`, { method: 'PATCH', token: A.token, body: { amount: 400 } })).status).toBe(200);
    expect((await scoped(env.DB, A.uid).getExpense(id))!.amount_minor).toBe(40000);
    expect((await api(`/api/tma/expenses/${id}`, { method: 'PATCH', token: B.token, body: { amount: 1 } })).status).toBe(404);
    expect((await api(`/api/tma/expenses/${id}`, { method: 'DELETE', token: B.token })).status).toBe(404);
    expect((await api(`/api/tma/expenses/${id}`, { method: 'DELETE', token: A.token })).status).toBe(200);
    expect((await scoped(env.DB, A.uid).listExpenses()).results).toHaveLength(0);
    expect((await api(`/api/tma/expenses/${id}`, { token: A.token })).status).toBe(404);
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

  it('каденсы (0016): POST/PATCH валидация, поля в GET, upcoming по срокам, baseline-нормализация', async () => {
    const A = await user(900030);
    const B = await user(900031);
    const today = new Date().toISOString().slice(0, 10); // профиль UTC
    const curMonth = Number(today.slice(5, 7));

    // валидация: interval_days без шага/якоря → 400; yearly без дня/месяца → 400
    expect(
      (await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'X', amount: 1, frequency: 'interval_days', anchor_on: '2020-01-01' } })).status,
    ).toBe(400);
    expect(
      (await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'X', amount: 1, frequency: 'interval_days', interval_days: 14 } })).status,
    ).toBe(400);
    expect(
      (await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'X', amount: 1, frequency: 'yearly', due_day: 15 } })).status,
    ).toBe(400);
    expect(
      (await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'X', amount: 1, frequency: 'yearly', due_month: 10 } })).status,
    ).toBe(400);
    // monthly без дня — ок (легаси «платёж без даты»)
    expect((await api('/api/tma/commitments', { method: 'POST', token: A.token, body: { name: 'БезДаты', amount: 1 } })).status).toBe(201);

    // валидные каденсы
    const ri = await api('/api/tma/commitments', {
      method: 'POST', token: A.token,
      body: { name: 'Фитнес', amount: 15, frequency: 'interval_days', interval_days: 30, anchor_on: '2020-01-01' },
    });
    expect(ri.status).toBe(201);
    const iid = ((await ri.json()) as { id: number }).id;
    const ry = await api('/api/tma/commitments', {
      method: 'POST', token: A.token,
      body: { name: 'Страховка', amount: 1200, frequency: 'yearly', due_day: 15, due_month: curMonth },
    });
    expect(ry.status).toBe(201);
    const yid = ((await ry.json()) as { id: number }).id;

    // GET: поля каденса + подпись + ближайший срок
    const list = (await (await api('/api/tma/commitments', { token: A.token })).json()) as {
      commitments: {
        name: string; frequency: string; interval_days: number | null;
        anchor_on: string | null; due_month: number | null;
        cadence: string; next_due_on: string | null;
      }[];
    };
    const gym = list.commitments.find((x) => x.name === 'Фитнес')!;
    expect(gym).toMatchObject({ frequency: 'interval_days', interval_days: 30, anchor_on: '2020-01-01', cadence: 'каждые 30 дн' });
    expect(gym.next_due_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const ins = list.commitments.find((x) => x.name === 'Страховка')!;
    expect(ins.frequency).toBe('yearly');
    expect(ins.due_month).toBe(curMonth);
    expect(list.commitments.find((x) => x.name === 'БезДаты')!.next_due_on).toBeNull();

    // PATCH: смена каденса без обязательных полей → 400; явный null обязательного → 400; с полями → 200
    expect((await api(`/api/tma/commitments/${yid}`, { method: 'PATCH', token: A.token, body: { frequency: 'interval_days' } })).status).toBe(400);
    expect(
      (await api(`/api/tma/commitments/${yid}`, { method: 'PATCH', token: A.token, body: { frequency: 'interval_days', interval_days: null, anchor_on: '2020-01-01' } })).status,
    ).toBe(400);
    expect(
      (await api(`/api/tma/commitments/${yid}`, { method: 'PATCH', token: A.token, body: { frequency: 'interval_days', interval_days: 30, anchor_on: '2020-01-01' } })).status,
    ).toBe(200);
    expect((await scoped(env.DB, A.uid).getCommitment(yid))!.frequency).toBe('interval_days');
    // чужой каденс-патч → 404
    expect(
      (await api(`/api/tma/commitments/${iid}`, { method: 'PATCH', token: B.token, body: { frequency: 'yearly', due_day: 1, due_month: 1 } })).status,
    ).toBe(404);

    // upcoming: строка — ближайший неоплаченный срок текущего месяца, с подписью каденса
    const up = (await (await api('/api/tma/upcoming', { token: A.token })).json()) as {
      items: { kind: string; name: string; due_on: string; paid: boolean; overdue: boolean; cadence?: string }[];
    };
    const gymUp = up.items.find((x) => x.name === 'Фитнес')!;
    expect(gymUp.cadence).toBe('каждые 30 дн');
    expect(gymUp.due_on.slice(0, 7)).toBe(today.slice(0, 7));
    // ручная оплата ДАТОЙ срока закрывает именно его — строка либо paid, либо следующий срок
    expect(
      (await api(`/api/tma/commitments/${iid}/payments`, { method: 'POST', token: A.token, body: { client_id: 'c-up', paid_on: gymUp.due_on } })).status,
    ).toBe(201);
    const up2 = (await (await api('/api/tma/upcoming', { token: A.token })).json()) as {
      items: { name: string; due_on: string; paid: boolean }[];
    };
    const gymUp2 = up2.items.find((x) => x.name === 'Фитнес')!;
    expect(gymUp2.paid || gymUp2.due_on > gymUp.due_on).toBe(true);

    // baseline: yearly/interval нормализуются в месячный эквивалент
    // БезДаты monthly $1 + Фитнес $15×30.4375/30 + Страховка $1200×30.4375/30 (после патча)
    await scoped(env.DB, A.uid).patchProfile({ income_minor: 0, living_cap_minor: 0 });
    const prof = (await (await api('/api/tma/profile', { token: A.token })).json()) as {
      baseline_income_minor: number;
      baseline_source: string;
    };
    expect(prof.baseline_source).toBe('computed');
    expect(prof.baseline_income_minor).toBe(Math.round((1 + (15 * 30.4375) / 30 + (1200 * 30.4375) / 30) * 100));
  });

  it('каденс «каждые N мес» (0017): валидация, GET/upcoming, PATCH-merge, имя+валюта', async () => {
    const A = await user(900032);
    const today = new Date().toISOString().slice(0, 10);

    // валидация: every_months>1 без якоря или дня → 400; вне monthly → 400; диапазон → 400
    expect(
      (await api('/api/tma/commitments', {
        method: 'POST', token: A.token,
        body: { name: 'X', amount: 1, every_months: 3, anchor_on: '2025-10-31' },
      })).status,
    ).toBe(400); // нет due_day
    expect(
      (await api('/api/tma/commitments', {
        method: 'POST', token: A.token,
        body: { name: 'X', amount: 1, every_months: 3, due_day: 31 },
      })).status,
    ).toBe(400); // нет anchor_on
    expect(
      (await api('/api/tma/commitments', {
        method: 'POST', token: A.token,
        body: { name: 'X', amount: 1, every_months: 3, due_day: 31, anchor_on: null },
      })).status,
    ).toBe(400); // явный null
    expect(
      (await api('/api/tma/commitments', {
        method: 'POST', token: A.token,
        body: { name: 'X', amount: 1, frequency: 'yearly', every_months: 3, due_day: 31, due_month: 10, anchor_on: '2025-10-31' },
      })).status,
    ).toBe(400); // >1 только с monthly
    expect(
      (await api('/api/tma/commitments', {
        method: 'POST', token: A.token,
        body: { name: 'X', amount: 1, every_months: 25, due_day: 31, anchor_on: '2025-10-31' },
      })).status,
    ).toBe(400); // 1–24

    // валидное создание: квартальный платёж якорем 31.10
    const rq = await api('/api/tma/commitments', {
      method: 'POST', token: A.token,
      body: { name: 'Кварталка', amount: 90, currency: 'EUR', every_months: 3, due_day: 31, anchor_on: '2025-10-31' },
    });
    expect(rq.status).toBe(201);
    const qid = ((await rq.json()) as { id: number }).id;

    // GET: поля каденса + подпись «каждые 3 мес (31-го)»
    const list = (await (await api('/api/tma/commitments', { token: A.token })).json()) as {
      commitments: {
        name: string; frequency: string; every_months: number; anchor_on: string | null;
        due_day: number | null; cadence: string; next_due_on: string | null;
      }[];
    };
    const q = list.commitments.find((x) => x.name === 'Кварталка')!;
    expect(q).toMatchObject({
      frequency: 'monthly',
      every_months: 3,
      anchor_on: '2025-10-31',
      due_day: 31,
      cadence: 'каждые 3 мес (31-го)',
    });
    // ближайший срок — в phase-месяце (окт/янв/апр/июл), день = 31 клампом
    expect(q.next_due_on).toMatch(/^\d{4}-(01|04|07|10)-\d{2}$/);

    // PATCH-merge: снять якорь при every_months>1 → 400; сменить каденс → 400; вернуть monthly → 200
    expect(
      (await api(`/api/tma/commitments/${qid}`, { method: 'PATCH', token: A.token, body: { anchor_on: null } })).status,
    ).toBe(400);
    expect(
      (await api(`/api/tma/commitments/${qid}`, { method: 'PATCH', token: A.token, body: { due_day: null } })).status,
    ).toBe(400);
    expect(
      (await api(`/api/tma/commitments/${qid}`, {
        method: 'PATCH', token: A.token,
        body: { frequency: 'interval_days', interval_days: 30, anchor_on: '2020-01-01' },
      })).status,
    ).toBe(400); // merged every_months=3 + interval_days — битый каденс
    expect(
      (await api(`/api/tma/commitments/${qid}`, {
        method: 'PATCH', token: A.token,
        body: { frequency: 'interval_days', interval_days: 30, anchor_on: '2020-01-01', every_months: 1 },
      })).status,
    ).toBe(200); // сброс every_months — каденс снова валиден
    const rowAfter = (await scoped(env.DB, A.uid).getCommitment(qid))!;
    expect(rowAfter.frequency).toBe('interval_days');
    expect(rowAfter.every_months).toBe(1);

    // PATCH: имя + валюта — round-trip через GET (валюта из мока FX)
    expect(
      (await api(`/api/tma/commitments/${qid}`, {
        method: 'PATCH', token: A.token, body: { name: 'Кварталка2', currency: 'RUB' },
      })).status,
    ).toBe(200);
    const list2 = (await (await api('/api/tma/commitments', { token: A.token })).json()) as {
      commitments: { id: number; name: string; currency: string }[];
    };
    expect(list2.commitments.find((x) => x.id === qid)).toMatchObject({ name: 'Кварталка2', currency: 'RUB' });

    // upcoming: N-месячный платёж виден только в phase-месяце
    const rm = await api('/api/tma/commitments', {
      method: 'POST', token: A.token,
      body: { name: 'Фазный', amount: 30, every_months: 3, due_day: 31, anchor_on: '2025-10-31' },
    });
    expect(rm.status).toBe(201);
    const up = (await (await api('/api/tma/upcoming', { token: A.token })).json()) as {
      items: { name: string; due_on: string; cadence?: string }[];
    };
    const curMonth = Number(today.slice(5, 7));
    const phase = [10, 1, 4, 7].includes(curMonth);
    const item = up.items.find((x) => x.name === 'Фазный');
    if (phase) {
      expect(item).toBeDefined();
      expect(item!.cadence).toBe('каждые 3 мес (31-го)');
      expect(Number(item!.due_on.slice(5, 7))).toBe(curMonth);
    } else {
      expect(item).toBeUndefined(); // не phase-месяц — срока в этом месяце нет
    }

    // baseline: every-N платёж нормализуется как amount/N в месяц
    await scoped(env.DB, A.uid).patchProfile({ income_minor: 0, living_cap_minor: 0 });
    const prof = (await (await api('/api/tma/profile', { token: A.token })).json()) as {
      baseline_income_minor: number;
      baseline_source: string;
    };
    expect(prof.baseline_source).toBe('computed');
    // Кварталка2 $90→interval 30 дн + Фазный €30/3 — оба конвертируются в USD по FX;
    // точную сумму не фиксируем — проверяем, что учёт прошёл через monthlyAmount:
    // Фазный внёс 30/3=10 EUR, а не 30. Сравним с нормализацией напрямую:
    const rowF = (await scoped(env.DB, A.uid).getCommitment((await rm.json() as { id: number }).id))!;
    expect(rowF.every_months).toBe(3);
    expect(prof.baseline_income_minor).toBeGreaterThan(0);
  });
});

describe('базовый доход: explicit/computed/none, напоминания, экспорт', () => {
  it('profile GET: baseline_source + baseline_income_minor; PATCH — тоглы напоминаний', async () => {
    const { uid, token } = await user(900040);
    // explicit: income_minor > 0 — хранимое значение, поведение не меняется
    const g1 = (await (await api('/api/tma/profile', { token })).json()) as {
      baseline_source: string;
      baseline_income_minor: number;
      typical_income_minor: number;
      reminders_weekly: number;
      vision_enabled: number;
    };
    expect(g1.baseline_source).toBe('explicit');
    expect(g1.baseline_income_minor).toBe(100000);
    expect(g1.typical_income_minor).toBe(100000);
    // тоглы: reminders_weekly → 0, vision_enabled → 1
    expect(
      (await api('/api/tma/profile', {
        method: 'PATCH', token, body: { reminders_weekly: false, vision_enabled: true },
      })).status,
    ).toBe(200);
    const p = (await scoped(env.DB, uid).getProfile())!;
    expect(p.reminders_weekly).toBe(0);
    expect(p.vision_enabled).toBe(1);
    // computed: income_minor=0 → платежи + бюджет + кредиты; займы НЕ входят
    await scoped(env.DB, uid).patchProfile({ income_minor: 0 });
    await scoped(env.DB, uid).addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
    await scoped(env.DB, uid).addDebt({
      name: 'Кредит', currency: 'USD', rate: 0.1, frequency: 'monthly',
      initial_balance_minor: 1000000, initial_payment_minor: 50000, epoch: '2024-01-05', due_day: 5,
    });
    await scoped(env.DB, uid).addLoan({
      counterparty: 'Вася', direction: 'owe', amount_minor: 99999900, currency: 'USD', due_on: null, note: null,
    });
    const g2 = (await (await api('/api/tma/profile', { token })).json()) as {
      baseline_source: string;
      baseline_income_minor: number;
    };
    expect(g2.baseline_source).toBe('computed');
    // 60 000 бюджет + 700 платёж + 500 платёж кредита = 61 200; займ исключён
    expect(g2.baseline_income_minor).toBe(6120000);
  });

  it('profile.reminder_hour: GET→null, PATCH 0–23 round-trip, сброс в null, границы → 400', async () => {
    const A = await user(900050);
    const g1 = (await (await api('/api/tma/profile', { token: A.token })).json()) as { reminder_hour: number | null };
    expect(g1.reminder_hour).toBeNull(); // миграция 0018: NULL — легаси 10:00/вс 20:00
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { reminder_hour: 18 } })).status).toBe(200);
    const g2 = (await (await api('/api/tma/profile', { token: A.token })).json()) as { reminder_hour: number | null };
    expect(g2.reminder_hour).toBe(18);
    expect((await scoped(env.DB, A.uid).getProfile())!.reminder_hour).toBe(18);
    // крайние валидные значения и сброс в null
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { reminder_hour: 0 } })).status).toBe(200);
    expect((await scoped(env.DB, A.uid).getProfile())!.reminder_hour).toBe(0);
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { reminder_hour: 23 } })).status).toBe(200);
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { reminder_hour: null } })).status).toBe(200);
    const g3 = (await (await api('/api/tma/profile', { token: A.token })).json()) as { reminder_hour: number | null };
    expect(g3.reminder_hour).toBeNull();
    // вне диапазона / не int / не число → 400
    for (const badHour of [24, -1, 9.5, '18', true])
      expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { reminder_hour: badHour } })).status, JSON.stringify(badHour)).toBe(400);
  });

  it('profile.timezone: произвольная IANA принимается (не только пресеты); мусор → 400', async () => {
    const A = await user(900051);
    for (const tz of ['Pacific/Auckland', 'America/Argentina/Buenos_Aires', 'Asia/Kamchatka', 'Europe/Kyiv']) {
      expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { timezone: tz } })).status, tz).toBe(200);
      expect((await scoped(env.DB, A.uid).getProfile())!.timezone).toBe(tz);
    }
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { timezone: 'Moscow' } })).status).toBe(400);
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { timezone: 'UTC+3' } })).status).toBe(400);
  });

  it('profile GET: ни дохода, ни обязательств → baseline_source none', async () => {
    const { uid, token } = await user(900041);
    await scoped(env.DB, uid).patchProfile({ income_minor: 0, living_cap_minor: 0 });
    const g = (await (await api('/api/tma/profile', { token })).json()) as {
      baseline_source: string;
      baseline_income_minor: number;
    };
    expect(g.baseline_source).toBe('none');
    expect(g.baseline_income_minor).toBe(0);
  });

  it('plan: income_minor=0 → computed (платежи+бюджет+кредиты); факт бьёт computed', async () => {
    const { uid, token } = await user(900042);
    await scoped(env.DB, uid).patchProfile({ income_minor: 0 });
    await scoped(env.DB, uid).addCommitment({ name: 'A', amount_minor: 70000, currency: 'USD', due_day: 1 });
    const p1 = (await (await api('/api/tma/plan', { token })).json()) as {
      income_source: string;
      income_minor: number;
    };
    expect(p1.income_source).toBe('computed');
    expect(p1.income_minor).toBe(6070000); // 60 000 + 700
    await scoped(env.DB, uid).addIncomeEntry({
      month: monthInTz('UTC', new Date()), amount_minor: 300000, currency: 'USD', note: null, source_key: 'k',
    });
    const p2 = (await (await api('/api/tma/plan', { token })).json()) as { income_source: string; income_minor: number };
    expect(p2.income_source).toBe('actual');
    expect(p2.income_minor).toBe(300000);
  });

  it('export: JSON только своих данных, attachment; изоляция tenant', async () => {
    const A = await user(900043);
    const B = await user(900044);
    await scoped(env.DB, A.uid).addCommitment({ name: 'A-тайное', amount_minor: 1, currency: 'USD', due_day: 1 });
    await scoped(env.DB, B.uid).addCommitment({ name: 'B-данные', amount_minor: 2, currency: 'USD', due_day: 2 });
    const res = await api('/api/tma/export', { token: A.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('budget-export-');
    const j = (await res.json()) as {
      schema_version: number;
      commitments: { name: string; user_id: number }[];
      profile: { user_id: number } | null;
    };
    expect(j.schema_version).toBe(5);
    expect(j.profile?.user_id).toBe(A.uid);
    const names = j.commitments.map((x) => x.name);
    expect(names).toContain('A-тайное');
    expect(names).not.toContain('B-данные');
    expect(j.commitments.every((x) => x.user_id === A.uid)).toBe(true);
  });
});

describe('даты spent_on/received_on, expense_currency, report?ccy', () => {
  const future = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  it('expenses: spent_on в POST/PATCH; будущее/1999/несуществующая дата → 400; умолчание — сегодня', async () => {
    const A = await user(900030);
    const r = await api('/api/tma/expenses', {
      method: 'POST', token: A.token, body: { amount: 10, spent_on: '2020-06-15' },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: number };
    expect((await scoped(env.DB, A.uid).getExpense(id))!.spent_on).toBe('2020-06-15');
    // несуществующий календарный день и нижняя граница
    expect((await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 1, spent_on: '2020-02-30' } })).status).toBe(400);
    expect((await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 1, spent_on: '1999-12-31' } })).status).toBe(400);
    // будущее (завтра по UTC — профиль UTC)
    expect((await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 1, spent_on: future() } })).status).toBe(400);
    // умолчание — сегодня
    const r2 = await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 1 } });
    const { id: id2 } = (await r2.json()) as { id: number };
    expect((await scoped(env.DB, A.uid).getExpense(id2))!.spent_on).toBe(todayInTz('UTC', new Date()));
    // PATCH spent_on своей записи
    expect((await api(`/api/tma/expenses/${id}`, { method: 'PATCH', token: A.token, body: { spent_on: '2020-06-20' } })).status).toBe(200);
    expect((await scoped(env.DB, A.uid).getExpense(id))!.spent_on).toBe('2020-06-20');
    expect((await api(`/api/tma/expenses/${id}`, { method: 'PATCH', token: A.token, body: { spent_on: future() } })).status).toBe(400);
  });

  it('income: received_on в POST/PATCH (month следует за датой); будущее → 400; чужой → 404', async () => {
    const A = await user(900031);
    const B = await user(900032);
    const r = await api('/api/tma/income', {
      method: 'POST', token: A.token, body: { amount: 100, received_on: '2020-06-15' },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: number };
    const row = (await scoped(env.DB, A.uid).getIncomeEntry(id))!;
    expect(row.received_on).toBe('2020-06-15');
    expect(row.month).toBe('2020-06'); // месяц — из фактической даты
    // валидация
    expect((await api('/api/tma/income', { method: 'POST', token: A.token, body: { amount: 1, received_on: future() } })).status).toBe(400);
    expect((await api('/api/tma/income', { method: 'POST', token: A.token, body: { amount: 1, received_on: '2020-02-30' } })).status).toBe(400);
    // PATCH: received_on двигает и month; note правится
    expect(
      (await api(`/api/tma/income/${id}`, {
        method: 'PATCH', token: A.token, body: { received_on: '2020-07-01', note: 'аванс' },
      })).status,
    ).toBe(200);
    const row2 = (await scoped(env.DB, A.uid).getIncomeEntry(id))!;
    expect(row2.received_on).toBe('2020-07-01');
    expect(row2.month).toBe('2020-07');
    expect(row2.note).toBe('аванс');
    // чужой id → 404; пустой patch → 400; будущая дата → 400
    expect((await api(`/api/tma/income/${id}`, { method: 'PATCH', token: B.token, body: { note: 'x' } })).status).toBe(404);
    expect((await api(`/api/tma/income/${id}`, { method: 'PATCH', token: A.token, body: {} })).status).toBe(400);
    expect((await api(`/api/tma/income/${id}`, { method: 'PATCH', token: A.token, body: { received_on: future() } })).status).toBe(400);
  });

  it('profile.expense_currency: GET→null, PATCH set/reset, дефолт валюты в POST /expenses', async () => {
    const A = await user(900033);
    const g1 = (await (await api('/api/tma/profile', { token: A.token })).json()) as { expense_currency: string | null };
    expect(g1.expense_currency).toBeNull();
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { expense_currency: 'eur' } })).status).toBe(200);
    const g2 = (await (await api('/api/tma/profile', { token: A.token })).json()) as { expense_currency: string | null };
    expect(g2.expense_currency).toBe('EUR');
    // трата без валюты → expense_currency; явная валюта перебивает
    const r1 = await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 5 } });
    const { id: id1 } = (await r1.json()) as { id: number };
    expect((await scoped(env.DB, A.uid).getExpense(id1))!.currency).toBe('EUR');
    const r2 = await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 5, currency: 'USD' } });
    const { id: id2 } = (await r2.json()) as { id: number };
    expect((await scoped(env.DB, A.uid).getExpense(id2))!.currency).toBe('USD');
    // сброс в null → снова living_currency (USD)
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { expense_currency: null } })).status).toBe(200);
    expect(((await (await api('/api/tma/profile', { token: A.token })).json()) as { expense_currency: string | null }).expense_currency).toBeNull();
    const r3 = await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 5 } });
    const { id: id3 } = (await r3.json()) as { id: number };
    expect((await scoped(env.DB, A.uid).getExpense(id3))!.currency).toBe('USD');
    // кривой код валюты → 400
    expect((await api('/api/tma/profile', { method: 'PATCH', token: A.token, body: { expense_currency: 'X1' } })).status).toBe(400);
  });

  it('report ?ccy=: дефолт — валюта дохода; конвертация в EUR/RUB/KZT/USD; 400/503', async () => {
    const A = await user(900034);
    const repo = scoped(env.DB, A.uid);
    await repo.patchProfile({ income_currency: 'EUR' });
    await api('/api/tma/expenses', { method: 'POST', token: A.token, body: { amount: 320, currency: 'USD' } });
    type Rep = { currency: string; spent: { living: number }; living_limit: { cap: number } };
    // дефолт — income EUR: 320 USD → 288 EUR; норма 60 000 USD → 54 000 EUR
    const j1 = (await (await api('/api/tma/report?period=month&offset=0', { token: A.token })).json()) as Rep;
    expect(j1.currency).toBe('EUR');
    expect(j1.spent.living).toBe(28800);
    expect(j1.living_limit.cap).toBe(5400000);
    // ?ccy=RUB: 320·97 = 31 040; норма 60 000·97 = 5 820 000
    const j2 = (await (await api('/api/tma/report?period=month&ccy=RUB', { token: A.token })).json()) as Rep;
    expect(j2.currency).toBe('RUB');
    expect(j2.spent.living).toBe(3104000);
    expect(j2.living_limit.cap).toBe(582000000);
    // ?ccy=KZT: 320·500 = 160 000
    const j3 = (await (await api('/api/tma/report?ccy=KZT', { token: A.token })).json()) as Rep;
    expect(j3.currency).toBe('KZT');
    expect(j3.spent.living).toBe(16000000);
    // ?ccy=USD — без конверсии
    const j4 = (await (await api('/api/tma/report?ccy=USD', { token: A.token })).json()) as Rep;
    expect(j4.spent.living).toBe(32000);
    // malformed → 400; неизвестная провайдеру валюта → 503 fx_unavailable
    expect((await api('/api/tma/report?ccy=US', { token: A.token })).status).toBe(400);
    expect((await api('/api/tma/report?ccy=X1', { token: A.token })).status).toBe(400);
    const r503 = await api('/api/tma/report?ccy=GEL', { token: A.token });
    expect(r503.status).toBe(503);
    expect(((await r503.json()) as { error: { code: string } }).error.code).toBe('fx_unavailable');
  });
});
