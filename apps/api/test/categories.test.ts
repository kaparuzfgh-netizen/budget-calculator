/**
 * categories.test.ts — фаза 1a: категории (домен, repo-скоуп, TMA, бот-флоу,
 * быстрый ввод «500 кафе», отчёт /report + rp:).
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRouter } from '../src/http/router';
import type { SendMessageOpts, TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { matchCategory, PRESETS } from '../src/domain/categories';
import { buildReport, periodRange } from '../src/domain/report';
import { accessRepo, scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';

const SECRET = 's3';
const OWNER = 555000111;
const JWT_SECRET = 'test-jwt';
const sent: { chatId: number; text: string; markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] } }[] = [];
const edited: { text: string }[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t, o?: SendMessageOpts) => {
    sent.push({ chatId: Number(c), text: t, markup: o?.replyMarkup as never });
  },
  editMessageText: async (c, _m, t) => {
    edited.push({ text: t });
  },
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
};
const fx: FxProvider = {
  latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97, KGS: 86.5 }, asOf: '2026-10-20' }),
};
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({
  ...env,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER),
  TELEGRAM_BOT_USERNAME: 'b',
  JWT_SECRET,
});

let u = 1;
const post = (body: unknown) =>
  app.fetch(
    new Request('https://t/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    tenv(),
  );
const msg = (tgId: number, text: string) =>
  post({
    update_id: u++,
    message: { message_id: u, text, chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'U' } },
  });
const cb = (tgId: number, data: string) =>
  post({
    update_id: u++,
    callback_query: {
      id: 'c' + u,
      data,
      from: { id: tgId, first_name: 'U' },
      message: { message_id: 42, chat: { id: tgId, type: 'private' } },
    },
  });
const api = (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) =>
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
const last = () => sent.at(-1)!.text;

async function user(tgId: number) {
  await accessRepo(env.DB).createUser(tgId, 'U', 'member');
  const uid = (await accessRepo(env.DB).findUserByTelegramId(tgId))!.id;
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD',
    income_currency: 'USD',
    living_currency: 'USD',
    timezone: 'UTC',
    income_minor: 100000,
    living_cap_minor: 6000000,
    weekly_budget_minor: 1384615,
    bonus_prepay_share: 0,
    bonus_dca_share: 0,
    onboarded_at: 'x',
  });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  edited.length = 0;
  for (const t of [
    'conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'loan_events', 'loans',
    'exchanges', 'debt_events', 'debts', 'commitment_payments', 'commitments', 'categories',
    'profiles', 'consents', 'reminder_log', 'fx_rates', 'processed_updates', 'audit_log', 'users',
  ])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

// ── domain ──
describe('matchCategory', () => {
  const cats = PRESETS.map((p, i) => ({ id: i + 1, name: p.name, preset_key: p.key, archived: 0 }));
  it('пресет-алиас; первый токен вырезается из заметки', () => {
    const m = matchCategory('кафе с коллегами', cats);
    expect(m.categoryId).toBe(cats.find((c) => c.preset_key === 'cafe')!.id);
    expect(m.note).toBe('с коллегами');
  });
  it('своя категория приоритетнее пресета; archived игнорируется; нет совпадения → note как была', () => {
    const my = [...cats, { id: 99, name: 'Кафедра', preset_key: null, archived: 0 }];
    expect(matchCategory('кафедра по средам', my).categoryId).toBe(99); // имя начинается с токена
    const arch = cats.map((c) => (c.preset_key === 'cafe' ? { ...c, archived: 1 } : c));
    expect(matchCategory('кафе', arch).categoryId).toBeNull();
    expect(matchCategory('qwerty', cats)).toEqual({ categoryId: null, note: 'qwerty' });
    expect(matchCategory('кофе', cats).note).toBeNull(); // весь текст — токен
  });
});

describe('periodRange', () => {
  it('week: пн–вс; вс остаётся в той же неделе, пн — следующая', () => {
    expect(periodRange('week', '2026-10-29').from).toBe('2026-10-26');
    expect(periodRange('week', '2026-11-01').to).toBe('2026-11-01'); // воскресенье — конец той же недели
    expect(periodRange('week', '2026-11-02').from).toBe('2026-11-02'); // понедельник — новая
    expect(periodRange('week', '2026-10-29').label).toBe('26 окт – 1 ноя 2026');
  });
  it('month/quarter/half/year + offset через границу года', () => {
    const mo = periodRange('month', '2026-10-15');
    expect([mo.from, mo.to, mo.label, mo.buckets.length]).toEqual(['2026-10-01', '2026-10-31', 'Октябрь 2026', 31]);
    expect(periodRange('month', '2026-01-10', -1).label).toBe('Декабрь 2025');
    expect(periodRange('quarter', '2026-10-15', -1).label).toBe('III кв. 2026');
    expect(periodRange('half', '2026-02-15').label).toBe('1-е полугодие 2026');
    expect(periodRange('half', '2026-02-15', -1).from).toBe('2025-07-01');
    const y = periodRange('year', '2026-06-01', -1);
    expect([y.label, y.buckets.length, y.buckets[0]!.label]).toEqual(['2025', 12, 'янв']);
  });
});

describe('buildReport', () => {
  it('все потоки: owe/owed, FX, предыдущий период, лимит по масштабу', () => {
    const range = periodRange('month', '2026-10-15');
    const rep = buildReport({
      period: 'month',
      offset: 0,
      range,
      prevRange: periodRange('month', '2026-10-15', -1),
      currency: 'USD',
      perUsd: { USD: 1, RUB: 97 },
      fx_as_of: '2026-10-20',
      livingCapMajor: 600,
      weeklyBudgetMajor: 150,
      categories: [{ id: 1, name: 'Продукты', emoji: '🛒' }],
      expenses: [
        { id: 1, spent_on: '2026-10-05', amount_minor: 10000, currency: 'USD', note: null, category_id: 1 },
        { id: 2, spent_on: '2026-10-06', amount_minor: 9700, currency: 'RUB', note: null, category_id: null },
        { id: 3, spent_on: '2026-09-20', amount_minor: 5000, currency: 'USD', note: null, category_id: null },
      ],
      commitPays: [{ paid_on: '2026-10-01', amount_minor: 2000, currency: 'USD' }],
      debtEvents: [{ event_on: '2026-10-02', amount_minor: 3000, currency: 'USD', kind: 'payment' }],
      loanEvents: [
        { event_on: '2026-10-04', amount_minor: 1000, currency: 'USD', direction: 'owed' },
        { event_on: '2026-10-04', amount_minor: 500, currency: 'USD', direction: 'owe' },
      ],
      income: [{ received_on: '2026-10-01', amount_minor: 50000, currency: 'USD' }],
    });
    expect(rep.received).toEqual({ income: 50000, loans_returned: 1000, total: 51000 });
    expect(rep.spent).toEqual({ living: 10100, commitments: 2000, credits: 3000, loans_repaid: 500, total: 15600 });
    expect(rep.net).toBe(35400);
    expect(rep.living_limit.cap).toBe(60000);
    expect(rep.prev.spent_total).toBe(5000);
    const unc = rep.categories.find((c) => c.id === null)!;
    expect(unc.name).toBe('Без категории');
    expect(rep.categories[0]!.id).toBe(1);
    expect(rep.buckets).toHaveLength(31);
    expect(rep.top_expenses[0]!.id).toBe(1);
    // неделя: лимит = недельный бюджет
    const w = buildReport({ period: 'week', offset: 0, range: periodRange('week', '2026-10-15'), prevRange: periodRange('week', '2026-10-15', -1), currency: 'USD', perUsd: { USD: 1 }, fx_as_of: '', livingCapMajor: 600, weeklyBudgetMajor: 150, categories: [], expenses: [], commitPays: [], debtEvents: [], loanEvents: [], income: [] });
    expect(w.living_limit.cap).toBe(15000);
  });
});

// ── repo / tenant ──
describe('repo: категории и category_id', () => {
  it('ensureCategories → 10 пресетов; name/emoji — enc1:; foreign id не пишется', async () => {
    const { uid: a } = await user(OWNER + 50);
    const { uid: b } = await user(OWNER + 51);
    const ra = scoped(env.DB, a);
    const rb = scoped(env.DB, b);
    await ra.ensureCategories();
    await ra.ensureCategories(); // идемпотентно
    expect((await ra.listCategories()).results).toHaveLength(10);
    const raw = await env.DB.prepare('SELECT name FROM categories WHERE user_id = ?').bind(a).first<{ name: string }>();
    expect(raw!.name).toMatch(/^enc1:/);
    // чужая категория: repo-гард зануляет запись
    const catA = (await ra.listCategories()).results[0]!;
    const r = await rb.addExpense({ spent_on: '2026-10-01', amount_minor: 1, currency: 'USD', note: null, source: 'manual', source_key: 'k', category_id: catA.id });
    const ex = await rb.getExpense(Number(r.meta.last_row_id));
    expect(ex!.category_id).toBeNull();
    // и patch тоже
    const r2 = await rb.addExpense({ spent_on: '2026-10-01', amount_minor: 1, currency: 'USD', note: null, source: 'manual', source_key: 'k2' });
    await rb.patchExpense(Number(r2.meta.last_row_id), { category_id: catA.id });
    expect((await rb.getExpense(Number(r2.meta.last_row_id)))!.category_id).toBeNull();
    // изоляция чтений
    expect(await rb.getCategory(catA.id)).toBeNull();
  });

  it('deleteCategory обнуляет ссылки; delete_me/export покрывают categories', async () => {
    const { uid } = await user(OWNER + 52);
    const r = scoped(env.DB, uid);
    await r.ensureCategories();
    const cat = (await r.listCategories()).results[0]!;
    const e = await r.addExpense({ spent_on: '2026-10-01', amount_minor: 1, currency: 'USD', note: null, source: 'manual', source_key: 'k', category_id: cat.id });
    const exId = Number(e.meta.last_row_id);
    await r.deleteCategory(cat.id);
    expect((await r.getExpense(exId))!.category_id).toBeNull();
    // export
    const exp = await r.exportUserData();
    expect(exp.categories).toHaveLength(9); // остались 9
    await r.deleteAllUserData();
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM categories WHERE user_id = ?').bind(uid).first<{ n: number }>())!.n).toBe(0);
  });
});

// ── TMA ──
describe('TMA /api/tma/categories + report', () => {
  it('CRUD, лимиты, изоляция; expense auto-category; report форма и 400', async () => {
    const { uid: a, token: ta } = await user(OWNER + 60);
    const { token: tb } = await user(OWNER + 61);
    // 401 без токена
    expect((await api('/api/tma/categories')).status).toBe(401);
    // GET → пресеты засеяны
    const g = await (await api('/api/tma/categories', { token: ta })).json() as { categories: { id: number; preset_key: string | null }[] };
    expect(g.categories).toHaveLength(10);
    expect(g.categories[0]!.preset_key).toBe('food');
    const cafe = g.categories.find((c) => c.preset_key === 'cafe')!;
    // POST своей
    const pc = await api('/api/tma/categories', { method: 'POST', body: { name: 'Своя', emoji: '🐱' }, token: ta });
    expect(pc.status).toBe(201);
    const { id: catId } = (await pc.json()) as { id: number };
    // PATCH/DELETE чужой — 404
    expect((await api(`/api/tma/categories/${catId}`, { method: 'PATCH', body: { name: 'x' }, token: tb })).status).toBe(404);
    expect((await api(`/api/tma/categories/${catId}`, { method: 'DELETE', token: tb })).status).toBe(404);
    // expense auto-category: «кафе» → cafe + заметка обрезана
    const pe = await api('/api/tma/expenses', { method: 'POST', body: { amount: 5, note: 'кафе с коллегами' }, token: ta });
    expect(pe.status).toBe(201);
    const { id: exId } = (await pe.json()) as { id: number };
    const ex = await scoped(env.DB, a).getExpense(exId);
    expect(ex!.category_id).toBe(cafe.id);
    expect(ex!.note).toBe('с коллегами');
    // чужой category_id → 400
    expect((await api('/api/tma/expenses', { method: 'POST', body: { amount: 5, category_id: catId + 9999 }, token: ta })).status).toBe(400);
    // report
    const rep = await api('/api/tma/report?period=month&offset=0', { token: ta });
    expect(rep.status).toBe(200);
    const rj = (await rep.json()) as { label: string; spent: { living: number }; categories: unknown[] };
    expect(rj.label).toBe('Октябрь 2026');
    expect(rj.spent.living).toBe(500);
    expect((await api('/api/tma/report?period=bogus', { token: ta })).status).toBe(400);
    expect((await api('/api/tma/report?offset=1', { token: ta })).status).toBe(400);
  });
});

describe('TMA /api/tma/upcoming', () => {
  it('форма, paid/overdue флаги, изоляция, biweekly исключён', async () => {
    const { uid: a, token: ta } = await user(OWNER + 80);
    const { uid: b, token: tb } = await user(OWNER + 81);
    expect((await api('/api/tma/upcoming')).status).toBe(401);
    const ra = scoped(env.DB, a);
    // платёж просрочен (due 1-е), платёж впереди (due 31-е), кредит monthly due 15, biweekly — не входит
    await ra.addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
    const c2 = await ra.addCommitment({ name: 'Интернет', amount_minor: 500, currency: 'USD', due_day: 31 });
    await ra.addDebt({ name: 'Ипотека', currency: 'USD', rate: 0.1, frequency: 'monthly', initial_balance_minor: 1000000, initial_payment_minor: 50000, epoch: '2026-10-01', due_day: 15, source_key: null });
    await ra.addDebt({ name: 'Рассрочка', currency: 'USD', rate: 0, frequency: 'biweekly', initial_balance_minor: 100000, initial_payment_minor: 10000, epoch: '2026-10-01', due_day: 10, source_key: null });
    await scoped(env.DB, b).addCommitment({ name: 'Чужое', amount_minor: 1, currency: 'USD', due_day: 2 });
    // оплачиваем интернет — paid=true
    await ra.addCommitmentPayment({ commitment_id: Number(c2.meta.last_row_id), amount_minor: 500, currency: 'USD', paid_on: '2026-10-20', source: 'manual', source_key: 'x' });
    const res = await api('/api/tma/upcoming', { token: ta });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { month: string; currency_hint: string; items: { kind: string; name: string; paid: boolean; overdue: boolean; due_on: string }[] };
    expect(j.currency_hint).toBe('USD');
    const names = j.items.map((x) => x.name);
    expect(names).toContain('Аренда');
    expect(names).toContain('Интернет');
    expect(names).toContain('Ипотека');
    expect(names).not.toContain('Рассрочка'); // biweekly не входит
    expect(names).not.toContain('Чужое'); // tenant B
    const ar = j.items.find((x) => x.name === 'Аренда')!;
    expect(ar.overdue).toBe(true); // due 1-е < today, не оплачено
    expect(ar.paid).toBe(false);
    const inet = j.items.find((x) => x.name === 'Интернет')!;
    expect(inet.paid).toBe(true);
    // неоплаченные первыми, отсортированы по due_on
    expect(j.items[0]!.paid).toBe(false);
    expect(j.items[0]!.due_on <= (j.items.find((x) => !x.paid && x !== j.items[0])?.due_on ?? '9999')).toBe(true);
    // у B пусто (нет платежей с due_day)
    const jb = (await (await api('/api/tma/upcoming', { token: tb })).json()) as { items: { name: string }[] };
    expect(jb.items.map((x) => x.name)).toEqual(['Чужое']);
  });
});

// ── бот ──
describe('бот: быстрый ввод, пикер категории, отчёт', () => {
  it('«500 кафе» → трата с категорией и обрезанной заметкой; «500» → пикер; «привет» — неизвестно', async () => {
    const { uid } = await user(OWNER + 70);
    await msg(OWNER + 70, '500 кафе с коллегами');
    expect(last()).toContain('Записал');
    expect(last()).toContain('Кафе и рестораны');
    const ex = (await scoped(env.DB, uid).listExpenses()).results[0]!;
    const cats = (await scoped(env.DB, uid).listCategories()).results;
    expect(ex.category_id).toBe(cats.find((c) => c.preset_key === 'cafe')!.id);
    expect(ex.note).toBe('с коллегами');
    // без категории → пикер
    await msg(OWNER + 70, '500');
    expect(last()).toContain('Выберите категорию');
    // «привет» — не сумма → неизвестная команда
    await msg(OWNER + 70, 'привет');
    expect(last()).toContain('Не знаю');
    // активный шаг не угоняется: spent_ask + мусор → ошибка парсера, не трата
    await msg(OWNER + 70, '➕ Трата');
    await msg(OWNER + 70, 'привет');
    expect(last()).not.toContain('Записал');
  });

  it('ex:sc назначает категорию и правит сообщение', async () => {
    const { uid } = await user(OWNER + 71);
    await msg(OWNER + 71, '300');
    const ex = (await scoped(env.DB, uid).listExpenses()).results[0]!;
    const cafe = (await scoped(env.DB, uid).listCategories()).results.find((c) => c.preset_key === 'cafe')!;
    await cb(OWNER + 71, `ex:sc:${ex.id}:${cafe.id}`);
    expect(edited.at(-1)!.text).toContain('Кафе и рестораны');
    expect((await scoped(env.DB, uid).getExpense(ex.id))!.category_id).toBe(cafe.id);
    // чужой cat id — молча
    const len = edited.length;
    await cb(OWNER + 71, `ex:sc:${ex.id}:99999`);
    expect(edited.length).toBe(len);
  });

  it('/report и rp:<period>:<offset> — правка сообщения', async () => {
    await user(OWNER + 72);
    await msg(OWNER + 72, '/report');
    expect(last()).toContain('Потрачено');
    expect(last()).toContain('Октябрь 2026');
    await cb(OWNER + 72, 'rp:week:0');
    expect(edited.at(-1)!.text).toContain('окт');
    await cb(OWNER + 72, 'rp:month:-1');
    expect(edited.at(-1)!.text).toContain('Сентябрь 2026');
    // невалидный — молча
    const len = edited.length;
    await cb(OWNER + 72, 'rp:bogus:0');
    expect(edited.length).toBe(len);
  });
});
