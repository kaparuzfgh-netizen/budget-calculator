/**
 * debts.test.ts — шаг 6 (веха H1): миграция debts/debt_events, редьюсер
 * advanceDebt, сервис replay, webhook-путь /debts и изоляция tenant.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { SendMessageOpts, TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { scoped, type DebtRow } from '../src/db/repo';
import { advanceDebt, debtCancelTarget, parseDayMonth, renderDebt, type DebtState } from '../src/bot/debts';
import { buildDebtCtx, debtView } from '../src/services/debts';
import type { FxResult } from '../src/fx/service';

const SECRET = 's3';
const OWNER = 555000111;
const sent: { chatId: number; text: string; markup?: unknown }[] = [];
const ALLOWED = new Set(['b', 'i', 'code', 'pre', 'a']);
function assertTgHtml(t: string) {
  const stack: string[] = [];
  const re = /<(\/)?([a-zA-Z]+)((?:\s[^<>]*)?)>/g;
  let m: RegExpExecArray | null;
  let last = 0;
  let rest = '';
  while ((m = re.exec(t))) {
    rest += t.slice(last, m.index);
    last = m.index + m[0].length;
    expect(ALLOWED.has(m[2]!.toLowerCase()), `тег <${m[2]}> в «${t.slice(0, 60)}»`).toBe(true);
    if (m[1]) expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2]!);
  }
  rest += t.slice(last);
  expect(stack).toEqual([]);
  expect(rest).not.toMatch(/[<>]/);
  expect(rest.replace(/&(lt|gt|amp|quot);/g, '')).not.toContain('&');
}
const tg: TelegramClient = {
  sendMessage: async (c, t, o?: SendMessageOpts) => {
    assertTgHtml(t);
    sent.push({ chatId: Number(c), text: t, markup: o?.replyMarkup });
  },
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
};
const fx: FxProvider = {
  latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97 }, asOf: '2026-10-20' }),
};
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({ ...env, TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_TELEGRAM_ID: String(OWNER) });
let u = 3000;
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
    message: { message_id: 1, text, chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'U' } },
  });
const cb = (tgId: number, data: string) =>
  post({
    update_id: u++,
    callback_query: { id: 'cb' + u, data, from: { id: tgId }, message: { chat: { id: tgId, type: 'private' } } },
  });
const last = () => sent.at(-1)!.text;
const fxGet = async (): Promise<FxResult> => ({ perUsd: { USD: 1, RUB: 97 }, asOf: 'x', stale: false });

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  for (const t of [
    'conversation_state',
    'debt_events',
    'debts',
    'income_entries',
    'weekly_expenses',
    'commitment_payments',
    'commitments',
    'profiles',
    'consents',
    'fx_rates',
    'processed_updates',
    'audit_log',
    'invites',
    'users',
  ])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function setupUser(tgId: number) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number(
    (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id,
  );
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD',
    income_currency: 'EUR',
    living_currency: 'RUB',
    timezone: 'Asia/Bishkek',
    income_minor: 620000,
    living_cap_minor: 6000000,
    weekly_budget_minor: 1384615,
    bonus_prepay_share: 0,
    bonus_dca_share: 0,
    onboarded_at: 'x',
  });
  return uid;
}

const DEBT = {
  name: 'Ипотека',
  currency: 'RUB',
  rate: 0.12,
  frequency: 'monthly' as const,
  initial_balance_minor: 100_000_000, // 1 000 000 ₽
  initial_payment_minor: 1_100_000, // 11 000 ₽/мес
  epoch: '2026-01-05',
  due_day: 5,
};
const addDebt = (uid: number, d: typeof DEBT = DEBT) => scoped(env.DB, uid).addDebt(d);

describe('repo: debts/debt_events', () => {
  it('CRUD скоуплен по user_id; чужой id — null/no-op', async () => {
    const uidA = await setupUser(OWNER + 80);
    const uidB = await setupUser(OWNER + 81);
    const r = await addDebt(uidA);
    const id = Number(r.meta.last_row_id);
    const repoA = scoped(env.DB, uidA);
    const repoB = scoped(env.DB, uidB);
    expect((await repoA.listDebts()).results).toHaveLength(1);
    expect((await repoA.getDebt(id))!.name).toBe('Ипотека');
    // B: не видит и не может трогать
    expect((await repoB.listDebts()).results).toHaveLength(0);
    expect(await repoB.getDebt(id)).toBeNull();
    expect((await repoB.patchDebt(id, { name: 'взлом' })).meta.changes).toBe(0);
    expect((await repoB.deleteDebt(id))[1]!.meta.changes).toBe(0);
    // событие на чужой долг не пишется (EXISTS внутри INSERT)
    const ev = await repoB.addDebtEvent({
      debt_id: id,
      kind: 'payment',
      amount_minor: 1,
      event_on: '2026-02-05',
      source: 'manual',
      source_key: 'tg:1',
    });
    expect(ev.meta.changes).toBe(0);
    expect((await repoA.listDebtEvents(id)).results).toHaveLength(0);
    // своё событие — пишется
    await repoA.addDebtEvent({
      debt_id: id,
      kind: 'payment',
      amount_minor: 11_000_00,
      event_on: '2026-02-05',
      source: 'manual',
      source_key: 'tg:2',
    });
    expect((await repoA.listDebtEvents(id)).results).toHaveLength(1);
    // B не читает журнал A
    expect((await repoB.listDebtEvents(id)).results).toHaveLength(0);
    // patch своего — работает
    await repoA.patchDebt(id, { active: 0 });
    expect((await repoA.listDebts()).results).toHaveLength(0); // activeOnly
    expect((await repoA.listDebts(false)).results).toHaveLength(1);
    // delete уносит долг с журналом
    await repoA.deleteDebt(id);
    expect(await repoA.getDebt(id)).toBeNull();
    expect((await repoA.listDebtEvents(id)).results).toHaveLength(0);
  });

  it('source_key — идемпотентность INSERT OR IGNORE', async () => {
    const uid = await setupUser(OWNER + 82);
    const id = Number((await addDebt(uid)).meta.last_row_id);
    const repo = scoped(env.DB, uid);
    const e = {
      debt_id: id,
      kind: 'payment' as const,
      amount_minor: 11_000_00,
      event_on: '2026-02-05',
      source: 'auto' as const,
      source_key: 'auto:1:2026-02',
    };
    await repo.addDebtEvent(e);
    const dup = await repo.addDebtEvent(e);
    expect(dup.meta.changes).toBe(0);
    expect((await repo.listDebtEvents(id)).results).toHaveLength(1);
    expect((await repo.findDebtEventByKey('auto:1:2026-02'))!.id).toBeGreaterThan(0);
  });
});

describe('services/debts: replay + проекция', () => {
  it('payment уменьшает остаток на тело; prepay режет платёж; reconcile ставит факт', async () => {
    const uid = await setupUser(OWNER + 83);
    const id = Number((await addDebt(uid)).meta.last_row_id);
    const repo = scoped(env.DB, uid);
    const debt = (await repo.getDebt(id))!;
    const v0 = await debtView(repo, debt, '2026-02-01');
    expect(v0.balance).toBeCloseTo(1_000_000, 2);
    expect(v0.payment).toBeCloseTo(11_000, 2);
    // платёж 11 000: проценты = 1e6*0.01 = 10 000 → тело −1000
    await repo.addDebtEvent({
      debt_id: id,
      kind: 'payment',
      amount_minor: 11_000_00,
      event_on: '2026-02-05',
      source: 'manual',
      source_key: 'k1',
    });
    const v1 = await debtView(repo, debt, '2026-02-06');
    expect(v1.balance).toBeCloseTo(999_000, 2);
    expect(v1.paymentsMade).toBe(1);
    // ЧДП 100 000 «платёж ↓»: остаток −100k, платёж пересчитан на остаток срока
    await repo.addDebtEvent({
      debt_id: id,
      kind: 'prepay',
      amount_minor: 100_000_00,
      event_on: '2026-02-10',
      source: 'manual',
      source_key: 'k2',
    });
    const v2 = await debtView(repo, debt, '2026-02-11');
    expect(v2.balance).toBeCloseTo(899_000, 2);
    expect(v2.payment).toBeLessThan(v1.payment);
    // сверка с банком: фактический остаток 880 000
    await repo.addDebtEvent({
      debt_id: id,
      kind: 'reconcile',
      amount_minor: 880_000_00,
      event_on: '2026-03-01',
      source: 'manual',
      source_key: 'k3',
    });
    const v3 = await debtView(repo, debt, '2026-03-02');
    expect(v3.balance).toBeCloseTo(880_000, 2);
    expect(v3.payment).toBeCloseTo(v2.payment, 2); // платёж не трогаем
    expect(v3.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('редьюсер advanceDebt (чистый)', () => {
  const NOW = new Date(Date.UTC(2026, 1, 10));
  const ctxOf = async (uid: number) => {
    const repo = scoped(env.DB, uid);
    return buildDebtCtx(repo, (await repo.getProfile())!, fxGet, NOW);
  };
  const st = (step: string, data: DebtState['data'] = {}): DebtState => ({ step, data });

  it('мастер monthly: name→balance→rate→payment→freq→due→debt_add', async () => {
    const uid = await setupUser(OWNER + 84);
    const ctx = await ctxOf(uid);
    let s: DebtState | null = st('debt');
    const feed = (i: Parameters<typeof advanceDebt>[1]) => {
      const r = advanceDebt(s!, i, ctx);
      s = r.state;
      return r.effects;
    };
    feed({ type: 'callback', data: 'dbt:add' });
    expect(s!.step).toBe('debt:add:name');
    feed({ type: 'text', text: 'Ипотека Сбер' });
    expect(s!.step).toBe('debt:add:balance');
    feed({ type: 'text', text: '2100000 rub' });
    expect(s!.step).toBe('debt:add:rate');
    feed({ type: 'text', text: '11.9' });
    expect(s!.step).toBe('debt:add:payment');
    feed({ type: 'text', text: '21500' });
    expect(s!.step).toBe('debt:add:freq');
    feed({ type: 'callback', data: 'dbt:af:m' });
    expect(s!.step).toBe('debt:add:due');
    const eff = feed({ type: 'text', text: '15' });
    const add = eff.find((e) => e.kind === 'debt_add');
    expect(add).toBeDefined();
    if (add?.kind === 'debt_add') {
      expect(add.d).toMatchObject({
        name: 'Ипотека Сбер',
        currency: 'RUB',
        amountMinor: 210_000_000,
        paymentMinor: 2_150_000,
        frequency: 'monthly',
        dueDay: 15,
      });
      expect(add.d.rate).toBeCloseTo(0.119, 6);
    }
    expect(eff.some((e) => e.kind === 'render' && e.screen === 'DEBTS')).toBe(true);
    expect(s!.step).toBe('debt');
  });

  it('мастер biweekly: freq→epoch (кнопка «Сегодня»)', async () => {
    const uid = await setupUser(OWNER + 85);
    const ctx = await ctxOf(uid);
    let s: DebtState | null = st('debt:add:freq', {
      add: { name: 'A', amountMinor: 100, currency: 'RUB', rate: 0.1, paymentMinor: 100 },
    });
    s = advanceDebt(s, { type: 'callback', data: 'dbt:af:b' }, ctx).state;
    expect(s!.step).toBe('debt:add:epoch');
    const eff = advanceDebt(s!, { type: 'callback', data: 'dbt:ae:today' }, ctx).effects;
    const add = eff.find((e) => e.kind === 'debt_add');
    if (add?.kind === 'debt_add') expect(add.d.frequency).toBe('biweekly');
    expect(add).toBeDefined();
  });

  it('stale/чужие колбэки — state без изменений, effects пустые', async () => {
    const uid = await setupUser(OWNER + 86);
    const ctx = await ctxOf(uid);
    const s = st('debt');
    for (const bad of ['dbt:del:yes', 'dbt:af:m', 'dbt:pay', 'dbt:pp', 'dbt:rc', 'dbt:ed', 'dbt:hist', 'dbt:v:', 'dbt:', 'pf:x', 'nv:home']) {
      const r = advanceDebt(s, { type: 'callback', data: bad }, ctx);
      expect(r.effects, bad).toEqual([]);
      expect(r.state).toEqual(s);
    }
    // чужой/несуществующий id — молча
    const r = advanceDebt(s, { type: 'callback', data: 'dbt:v:999' }, ctx);
    expect(r.effects).toEqual([]);
  });

  it('удаление: card→confirm→debt_del+render; отмена → DEBTS/HOME по реестру', async () => {
    const uid = await setupUser(OWNER + 87);
    await addDebt(uid);
    const ctx = await ctxOf(uid);
    const id = ctx.debts[0]!.debt.id;
    let s = advanceDebt(st('debt'), { type: 'callback', data: `dbt:v:${id}` }, ctx).state!;
    expect(s.step).toBe('debt:one');
    s = advanceDebt(s, { type: 'callback', data: `dbt:del:${id}` }, ctx).state!;
    expect(s.step).toBe('debt:del');
    const eff = advanceDebt(s, { type: 'callback', data: 'dbt:del:yes' }, ctx).effects;
    expect(eff.some((e) => e.kind === 'debt_del' && e.id === id)).toBe(true);
    // cancel target: из подтверждения → DEBT, из мастера → DEBTS
    expect(debtCancelTarget(st('debt:del', { debtId: id }))).toBe('DEBT');
    expect(debtCancelTarget(st('debt:pp', { debtId: id }))).toBe('DEBT');
    expect(debtCancelTarget(st('debt:recon', { debtId: id }))).toBe('DEBT');
    expect(debtCancelTarget(st('debt:edit:rate', { debtId: id }))).toBe('DEBT_EDIT');
    expect(debtCancelTarget(st('debt:hist', { debtId: id }))).toBe('DEBT');
    expect(debtCancelTarget(st('debt:add:rate'))).toBe('DEBTS');
    expect(debtCancelTarget(st('debt'))).toBe('HOME');
  });

  it('операции (H2): платёж, ЧДП превью→запись, сверка, правки, история', async () => {
    const uid = await setupUser(OWNER + 93);
    await addDebt(uid);
    const ctx = await ctxOf(uid);
    const id = ctx.debts[0]!.debt.id;
    // карточка → платёж → кнопка «по графику» (сумма = текущий платёж, дата = сегодня)
    let s = advanceDebt(st('debt'), { type: 'callback', data: `dbt:v:${id}` }, ctx).state!;
    s = advanceDebt(s, { type: 'callback', data: 'dbt:pay' }, ctx).state!;
    expect(s.step).toBe('debt:pay');
    const r1 = advanceDebt(s, { type: 'callback', data: 'dbt:pay:sched' }, ctx);
    expect(r1.effects.find((e) => e.kind === 'debt_event')).toMatchObject({
      ev: { kind: 'payment', amountMinor: 1_100_000, eventOn: '2026-02-10' },
    });
    // платёж суммой с датой
    const r2 = advanceDebt(st('debt:pay', { debtId: id }), { type: 'text', text: '11000 05.02' }, ctx);
    expect(r2.effects.find((e) => e.kind === 'debt_event')).toMatchObject({
      ev: { kind: 'payment', amountMinor: 1_100_000, eventOn: '2026-02-05' },
    });
    // ЧДП: превышение остатка — ошибка; сумма → экран превью → запись
    s = advanceDebt(st('debt:one', { debtId: id }), { type: 'callback', data: 'dbt:pp' }, ctx).state!;
    expect(s.step).toBe('debt:pp:ask');
    const tooMuch = advanceDebt(s, { type: 'text', text: '2000000' }, ctx);
    expect(tooMuch.effects[0]!.kind).toBe('send');
    expect(tooMuch.effects.some((e) => e.kind === 'debt_event')).toBe(false);
    s = advanceDebt(s, { type: 'text', text: '100000' }, ctx).state!;
    expect(s.step).toBe('debt:pp');
    // выбор режима: «платёж↓» и «срок↓» — разные mode в событии
    const r3 = advanceDebt(s, { type: 'callback', data: 'dbt:pp:go:p' }, ctx);
    expect(r3.effects.find((e) => e.kind === 'debt_event')).toMatchObject({
      ev: { kind: 'prepay', amountMinor: 10_000_000, eventOn: '2026-02-10', mode: 'reduce_payment' },
    });
    const r3t = advanceDebt(s, { type: 'callback', data: 'dbt:pp:go:t' }, ctx);
    expect(r3t.effects.find((e) => e.kind === 'debt_event')).toMatchObject({
      ev: { kind: 'prepay', amountMinor: 10_000_000, mode: 'reduce_term' },
    });
    // сверка с банком → reconcile с фактическим остатком
    const r4 = advanceDebt(st('debt:recon', { debtId: id }), { type: 'text', text: '990000' }, ctx);
    expect(r4.effects.find((e) => e.kind === 'debt_event')).toMatchObject({
      ev: { kind: 'reconcile', amountMinor: 99_000_000, eventOn: '2026-02-10' },
    });
    // правки: меню → ставка/платёж/день → debt_patch
    s = advanceDebt(st('debt:one', { debtId: id }), { type: 'callback', data: 'dbt:ed' }, ctx).state!;
    expect(s.step).toBe('debt:edit');
    s = advanceDebt(s, { type: 'callback', data: 'dbt:ed:rate' }, ctx).state!;
    expect(s.step).toBe('debt:edit:rate');
    const r5 = advanceDebt(s, { type: 'text', text: '12.5' }, ctx);
    expect(r5.effects.find((e) => e.kind === 'debt_patch')).toMatchObject({ patch: { rate: 0.125 } });
    const r6 = advanceDebt(st('debt:edit:payment', { debtId: id }), { type: 'text', text: '12500' }, ctx);
    expect(r6.effects.find((e) => e.kind === 'debt_patch')).toMatchObject({ patch: { initial_payment_minor: 1_250_000 } });
    const r7 = advanceDebt(st('debt:edit:day', { debtId: id }), { type: 'callback', data: 'dbt:ed:day:none' }, ctx);
    expect(r7.effects.find((e) => e.kind === 'debt_patch')).toMatchObject({ patch: { due_day: null } });
    // история — чужой паттерн колбэка игнорируется
    const r8 = advanceDebt(st('debt:hist', { debtId: id }), { type: 'callback', data: 'dbt:pp:go:p' }, ctx);
    expect(r8.effects).toEqual([]);
  });

  it('журнал событий: карточка → правка суммы/даты → переключение режима → удаление', async () => {
    const uid = await setupUser(OWNER + 96);
    const id = Number((await addDebt(uid)).meta.last_row_id);
    const repo = scoped(env.DB, uid);
    const ev = await repo.addDebtEvent({
      debt_id: id,
      kind: 'prepay',
      amount_minor: 10_000_000,
      event_on: '2026-02-07',
      mode: 'reduce_payment',
      source: 'manual',
      source_key: 'e1',
    });
    const evId = Number(ev.meta.last_row_id);
    const ctx = await ctxOf(uid);
    // журнал → карточка события
    const s1 = advanceDebt(st('debt:hist', { debtId: id }), { type: 'callback', data: `dbt:ev:${evId}` }, ctx);
    expect(s1.state!.step).toBe('debt:ev');
    // чужой event id — молча
    const s1x = advanceDebt(st('debt:hist', { debtId: id }), { type: 'callback', data: 'dbt:ev:9999' }, ctx);
    expect(s1x.effects).toEqual([]);
    // переключение режима ЧДП → debt_event_patch mode
    const rm = advanceDebt(s1.state!, { type: 'callback', data: `dbt:ev:m:${evId}` }, ctx);
    expect(rm.effects.find((e) => e.kind === 'debt_event_patch')).toMatchObject({ patch: { mode: 'reduce_term' } });
    // правка: промпт → сумма+дата → patch + возврат в карточку события
    const s2 = advanceDebt(s1.state!, { type: 'callback', data: `dbt:ev:e:${evId}` }, ctx).state!;
    expect(s2.step).toBe('debt:ev:edit');
    const re = advanceDebt(s2, { type: 'text', text: '90000 05.02' }, ctx);
    expect(re.effects.find((e) => e.kind === 'debt_event_patch')).toMatchObject({
      id: evId,
      patch: { amount_minor: 9_000_000, event_on: '2026-02-05' },
    });
    // удаление: confirm → del + возврат в журнал
    const s3 = advanceDebt(s1.state!, { type: 'callback', data: `dbt:ev:d:${evId}` }, ctx).state!;
    expect(s3.step).toBe('debt:ev:del');
    const rd = advanceDebt(s3, { type: 'callback', data: `dbt:ev:dy:${evId}` }, ctx);
    expect(rd.effects.find((e) => e.kind === 'debt_event_del')).toMatchObject({ id: evId });
    expect(rd.effects.find((e) => e.kind === 'render')).toMatchObject({ screen: 'DEBT_HIST' });
  });

  it('DEBT_PREPAY — превью «платёж↓»/«срок↓»; DEBT_HIST — журнал событий', async () => {
    const uid = await setupUser(OWNER + 94);
    const id = Number((await addDebt(uid)).meta.last_row_id);
    const repo = scoped(env.DB, uid);
    await repo.addDebtEvent({
      debt_id: id,
      kind: 'payment',
      amount_minor: 1_100_000,
      event_on: '2026-02-05',
      source: 'manual',
      source_key: 'e1',
    });
    await repo.addDebtEvent({
      debt_id: id,
      kind: 'prepay',
      amount_minor: 10_000_000,
      event_on: '2026-02-07',
      source: 'manual',
      source_key: 'e2',
    });
    const ctx = await ctxOf(uid);
    const pv = renderDebt('DEBT_PREPAY', { debtId: id, pp: { amountMinor: 10_000_000, eventOn: '2026-02-10' } }, ctx);
    expect(pv.text).toContain('Остаток');
    expect(pv.text).toContain('Платёж↓');
    expect(pv.text).toContain('Срок↓');
    expect(pv.text).toContain('мес');
    // журнал: события — кнопками (единый формат «событие → карточка»)
    const h2 = renderDebt('DEBT_HIST', { debtId: id }, ctx);
    expect(h2.text).toContain('Журнал');
    const flat = (h2.markup!.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[];
    expect(flat.some((b) => b.text.includes('Платёж'))).toBe(true);
    expect(flat.some((b) => b.text.includes('ЧДП'))).toBe(true);
    expect(flat.some((b) => b.callback_data.startsWith('dbt:ev:'))).toBe(true);
  });

  it('parseDayMonth и renderDebt пустого списка', async () => {
    expect(parseDayMonth('05.11', '2026-02-10')).toBe('2026-11-05');
    expect(parseDayMonth('5.11.26', '2026-02-10')).toBe('2026-11-05');
    expect(parseDayMonth('31.02', '2026-02-10')).toBeNull();
    expect(parseDayMonth('abc', '2026-02-10')).toBeNull();
    const uid = await setupUser(OWNER + 88);
    const ctx = await ctxOf(uid);
    const r = renderDebt('DEBTS', {}, ctx);
    expect(r.text).toContain('ни одного');
  });
});

describe('/debts webhook-путь', () => {
  const cbs = () =>
    (
      (sent.at(-1)!.markup as { inline_keyboard?: { callback_data?: string }[][] })?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => b.callback_data ?? '');

  it('/debts → мастер → долг в БД → карточка → удаление', async () => {
    const uid = await setupUser(OWNER + 89);
    await msg(OWNER + 89, '/credits');
    expect(last()).toContain('Кредиты');
    expect(cbs()).toContain('dbt:add');
    // мастер целиком через webhook
    await cb(OWNER + 89, 'dbt:add');
    await msg(OWNER + 89, 'Кредит');
    await msg(OWNER + 89, '500000 rub');
    await msg(OWNER + 89, '9.9');
    await msg(OWNER + 89, '15000');
    await cb(OWNER + 89, 'dbt:af:m');
    await msg(OWNER + 89, '20');
    expect(last()).toContain('Добавлен: Кредит');
    const rows = (await scoped(env.DB, uid).listDebts()).results;
    expect(rows).toHaveLength(1);
    const d: DebtRow = rows[0]!;
    expect(d).toMatchObject({ name: 'Кредит', currency: 'RUB', due_day: 20, frequency: 'monthly' });
    // карточка
    await cb(OWNER + 89, `dbt:v:${d.id}`);
    expect(last()).toContain('Кредит');
    expect(last()).toContain('500 000'); // fmtMoney — неразрывный пробел
    // удаление
    await cb(OWNER + 89, `dbt:del:${d.id}`);
    expect(last()).toContain('Удалить кредит');
    await cb(OWNER + 89, 'dbt:del:yes');
    expect(last()).toContain('Удалён: Кредит');
    expect((await scoped(env.DB, uid).listDebts()).results).toHaveLength(0);
  });

  it('операции через webhook: платёж → ЧДП → сверка → история', async () => {
    const uid = await setupUser(OWNER + 95);
    const id = Number((await addDebt(uid)).meta.last_row_id);
    await msg(OWNER + 95, '/credits');
    await cb(OWNER + 95, `dbt:v:${id}`);
    // платёж кнопкой «по графику» — событие в журнале
    await cb(OWNER + 95, 'dbt:pay');
    await cb(OWNER + 95, 'dbt:pay:sched');
    expect(last()).toContain('Платёж записан');
    expect((await scoped(env.DB, uid).listDebtEvents(id)).results).toHaveLength(1);
    // ЧДП текстом → превью → подтверждение
    await cb(OWNER + 95, 'dbt:pp');
    await msg(OWNER + 95, '100000');
    expect(last()).toContain('Платёж↓');
    expect(cbs()).toContain('dbt:pp:go:p');
    expect(cbs()).toContain('dbt:pp:go:t');
    await cb(OWNER + 95, 'dbt:pp:go:p');
    expect(last()).toContain('ЧДП записано');
    // сверка с банком
    await cb(OWNER + 95, 'dbt:rc');
    await msg(OWNER + 95, '880000');
    expect(last()).toContain('Сверено');
    // история: 3 события — платёж, ЧДП, сверка
    await cb(OWNER + 95, 'dbt:hist');
    expect((await scoped(env.DB, uid).listDebtEvents(id)).results).toHaveLength(3);
    // событие → правка суммы → удаление; журнал пересчитывается
    const evId = (await scoped(env.DB, uid).listDebtEvents(id)).results[0]!.id;
    await cb(OWNER + 95, `dbt:ev:${evId}`);
    expect(last()).toContain('Платёж');
    await cb(OWNER + 95, `dbt:ev:e:${evId}`);
    await msg(OWNER + 95, '12000');
    expect(last()).toContain('Записано');
    expect((await scoped(env.DB, uid).getDebtEvent(evId))?.amount_minor).toBe(1_200_000);
    await cb(OWNER + 95, `dbt:ev:d:${evId}`);
    await cb(OWNER + 95, `dbt:ev:dy:${evId}`);
    expect(last()).toContain('удалено');
    expect((await scoped(env.DB, uid).listDebtEvents(id)).results).toHaveLength(2);
  });

  it('изоляция: чужой debt id не открывается и не удаляется', async () => {
    const uidA = await setupUser(OWNER + 90);
    await setupUser(OWNER + 91);
    await addDebt(uidA, { ...DEBT, name: 'Чужая ипотека' });
    const idA = (await scoped(env.DB, uidA).listDebts()).results[0]!.id;
    // B открывает свой список — пустой
    await msg(OWNER + 91, '/credits');
    const n = sent.length;
    await cb(OWNER + 91, `dbt:v:${idA}`); // id чужого долга — молча
    expect(sent.length).toBe(n);
    // B вводит текст на шаге 'debt' — не ввод, unknownCommand
    await msg(OWNER + 91, 'привет');
    expect(last()).not.toContain('Чужая');
    // B пытается удалить чужой долг: перейти в debt:one не вышло, шаг 'debt'
    await cb(OWNER + 91, `dbt:del:${idA}`);
    expect(sent.length).toBe(n + 1); // только unknownCommand от 'привет'
    expect((await scoped(env.DB, uidA).listDebts()).results).toHaveLength(1);
  });

  it('stale dbt-колбэк на pf-шаге молча игнорируется', async () => {
    await setupUser(OWNER + 92);
    await msg(OWNER + 92, '⚙️ Профиль'); // шаг pf:*
    const n = sent.length;
    await cb(OWNER + 92, 'dbt:add');
    await cb(OWNER + 92, 'dbt:del:yes');
    expect(sent.length).toBe(n);
  });
});
