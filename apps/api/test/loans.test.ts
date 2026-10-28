/**
 * loans.test.ts — «Долги людям»: миграция loans/loan_events, редьюсер
 * advanceLoan, replay возвратов, webhook-путь /loans и изоляция tenant.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { SendMessageOpts, TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { scoped, type LoanRow } from '../src/db/repo';
import { advanceLoan, loanCancelTarget, renderLoan, type LoanState } from '../src/bot/loans';
import { buildLoanCtx, loanView, loanViews } from '../src/services/loans';
import { replayLoan } from '../src/domain/loan';
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
let u = 6000;
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
    'loan_events',
    'loans',
    'debt_events',
    'debts',
    'income_entries',
    'weekly_expenses', 'categories',
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

const LOAN = {
  counterparty: 'Вася',
  direction: 'owe' as const,
  amount_minor: 30_000, // 300 $
  currency: 'USD',
  due_on: '2026-11-15',
  note: null,
};
const addLoan = (uid: number, l: typeof LOAN = LOAN) => scoped(env.DB, uid).addLoan(l);

describe('domain/loan: replay', () => {
  it('open → partial → closed; переплата → closed; closed_at глушит остаток', () => {
    expect(replayLoan(300, [], null)).toMatchObject({ repaid: 0, remaining: 300, status: 'open' });
    expect(replayLoan(300, [{ kind: 'repay', amount: 100 }], null)).toMatchObject({
      repaid: 100,
      remaining: 200,
      status: 'partial',
    });
    expect(replayLoan(300, [{ kind: 'repay', amount: 300 }], null).status).toBe('closed');
    // переплата — не отрицательный остаток
    expect(replayLoan(300, [{ kind: 'repay', amount: 350 }], null).remaining).toBe(0);
    // ручное закрытие — остаток прощён
    expect(replayLoan(300, [{ kind: 'repay', amount: 50 }], '2026-11-01')).toMatchObject({
      remaining: 0,
      status: 'closed',
    });
  });
});

describe('repo: loans/loan_events', () => {
  it('CRUD скоуплен по user_id; чужой id — null/no-op; событие на чужой заём не пишется', async () => {
    const uidA = await setupUser(OWNER + 80);
    const uidB = await setupUser(OWNER + 81);
    const r = await addLoan(uidA);
    const id = Number(r.meta.last_row_id);
    const repoA = scoped(env.DB, uidA);
    const repoB = scoped(env.DB, uidB);
    expect((await repoA.listLoans()).results).toHaveLength(1);
    expect((await repoA.getLoan(id))!.counterparty).toBe('Вася');
    // B: не видит и не может трогать
    expect((await repoB.listLoans()).results).toHaveLength(0);
    expect(await repoB.getLoan(id)).toBeNull();
    expect((await repoB.closeLoan(id)).meta.changes).toBe(0);
    expect((await repoB.deleteLoan(id))[1]!.meta.changes).toBe(0);
    const ev = await repoB.addLoanEvent({
      loan_id: id,
      amount_minor: 1,
      event_on: '2026-10-01',
      source: 'manual',
      source_key: null,
    });
    expect(ev.meta.changes).toBe(0);
    expect((await repoA.listLoanEvents(id)).results).toHaveLength(0);
    // своё событие — пишется; журнал B не читает
    await repoA.addLoanEvent({ loan_id: id, amount_minor: 10_000, event_on: '2026-10-01', source: 'manual', source_key: null });
    expect((await repoA.listLoanEvents(id)).results).toHaveLength(1);
    expect((await repoB.listLoanEvents(id)).results).toHaveLength(0);
    // close — идемпотентно
    expect((await repoA.closeLoan(id)).meta.changes).toBe(1);
    expect((await repoA.closeLoan(id)).meta.changes).toBe(0);
    // delete уносит заём с журналом
    await repoA.deleteLoan(id);
    expect(await repoA.getLoan(id)).toBeNull();
    expect((await repoA.listLoanEvents(id)).results).toHaveLength(0);
  });
});

describe('services/loans: view и контекст', () => {
  it('repay уменьшает остаток; разделение «я должен / мне должны» + итоги USD', async () => {
    const uid = await setupUser(OWNER + 82);
    const repo = scoped(env.DB, uid);
    const id = Number((await addLoan(uid)).meta.last_row_id);
    await repo.addLoan({
      counterparty: 'Петя',
      direction: 'owed',
      amount_minor: 2_000_000, // 20 000 ₽
      currency: 'RUB',
      due_on: null,
      note: 'займ',
    });
    const p = (await repo.getProfile())!;
    const ctx = await buildLoanCtx(repo, p, fxGet, new Date(Date.UTC(2026, 9, 20)));
    expect(ctx.owe).toHaveLength(1);
    expect(ctx.owed).toHaveLength(1);
    expect(ctx.oweUsd).toBeCloseTo(300, 0);
    expect(ctx.owedUsd).toBeCloseTo(20_000 / 97, 0);
    // частичный возврат
    await repo.addLoanEvent({ loan_id: id, amount_minor: 10_000, event_on: '2026-10-20', source: 'manual', source_key: null });
    const v = await loanView(repo, (await repo.getLoan(id))!);
    expect(v.status).toBe('partial');
    expect(v.remaining).toBeCloseTo(200, 2);
  });

  it('P2-2: loanViews читает журналы одним запросом — listLoanEvents не зовётся (нет N+1)', async () => {
    const uid = await setupUser(OWNER + 97);
    const repo = scoped(env.DB, uid);
    const id1 = Number((await addLoan(uid)).meta.last_row_id);
    const id2 = Number((await addLoan(uid, { ...LOAN, counterparty: 'Петя' })).meta.last_row_id);
    await repo.addLoanEvent({ loan_id: id1, amount_minor: 10_000, event_on: '2026-10-01', source: 'manual', source_key: 'e1' });
    await repo.addLoanEvent({ loan_id: id2, amount_minor: 20_000, event_on: '2026-10-02', source: 'manual', source_key: 'e2' });
    const spy = vi.spyOn(repo, 'listLoanEvents');
    const views = await loanViews(repo);
    expect(spy).not.toHaveBeenCalled();
    // replay-контракт тот же: события сгруппированы по займам в порядке replay
    const v1 = views.find((v) => v.loan.id === id1)!;
    const v2 = views.find((v) => v.loan.id === id2)!;
    expect(v1.events.map((e) => e.amount_minor)).toEqual([10_000]);
    expect(v2.events.map((e) => e.amount_minor)).toEqual([20_000]);
    expect(v1.repaid).toBeCloseTo(100, 2);
    expect(v2.repaid).toBeCloseTo(200, 2);
    spy.mockRestore();
  });
});

describe('редьюсер advanceLoan (чистый)', () => {
  const NOW = new Date(Date.UTC(2026, 9, 20));
  const ctxOf = async (uid: number) => {
    const repo = scoped(env.DB, uid);
    return buildLoanCtx(repo, (await repo.getProfile())!, fxGet, NOW);
  };
  const st = (step: string, data: LoanState['data'] = {}): LoanState => ({ step, data });

  it('мастер «я должен»: dir→name→amount→due→note→loan_add', async () => {
    const uid = await setupUser(OWNER + 83);
    const ctx = await ctxOf(uid);
    let s: LoanState | null = st('loan');
    const feed = (i: Parameters<typeof advanceLoan>[1]) => {
      const r = advanceLoan(s!, i, ctx);
      s = r.state;
      return r.effects;
    };
    feed({ type: 'callback', data: 'ln:add' });
    expect(s!.step).toBe('loan:add:dir');
    feed({ type: 'callback', data: 'ln:dir:owe' });
    expect(s!.step).toBe('loan:add:name');
    feed({ type: 'text', text: 'Вася' });
    expect(s!.step).toBe('loan:add:amount');
    feed({ type: 'text', text: '300 usd' });
    expect(s!.step).toBe('loan:add:due');
    feed({ type: 'text', text: '15.11' });
    expect(s!.step).toBe('loan:add:note');
    const eff = feed({ type: 'text', text: 'за телефон' });
    const add = eff.find((e) => e.kind === 'loan_add');
    expect(add).toBeDefined();
    if (add?.kind === 'loan_add') {
      expect(add.d).toMatchObject({
        counterparty: 'Вася',
        direction: 'owe',
        amountMinor: 30_000,
        currency: 'USD',
        dueOn: '2026-11-15',
        note: 'за телефон',
      });
    }
    expect(eff.some((e) => e.kind === 'render' && e.screen === 'LOANS')).toBe(true);
    expect(s!.step).toBe('loan');
  });

  it('мастер «мне должны» + «Без срока» + «Пропустить»', async () => {
    const uid = await setupUser(OWNER + 84);
    const ctx = await ctxOf(uid);
    let s: LoanState | null = st('loan:add:dir');
    s = advanceLoan(s, { type: 'callback', data: 'ln:dir:owed' }, ctx).state;
    s = advanceLoan(s!, { type: 'text', text: 'Петя' }, ctx).state;
    s = advanceLoan(s!, { type: 'text', text: '20000 rub' }, ctx).state;
    s = advanceLoan(s!, { type: 'callback', data: 'ln:nodue' }, ctx).state;
    expect(s!.step).toBe('loan:add:note');
    const eff = advanceLoan(s!, { type: 'callback', data: 'ln:nonote' }, ctx).effects;
    const add = eff.find((e) => e.kind === 'loan_add');
    if (add?.kind === 'loan_add') {
      expect(add.d.direction).toBe('owed');
      expect(add.d.dueOn).toBeNull();
      expect(add.d.note).toBeNull();
    }
    expect(add).toBeDefined();
  });

  it('лимит P2-2: на 100 открытых «ln:add» не стартует мастер — send с лимитом', async () => {
    const uid = await setupUser(OWNER + 96);
    const repo = scoped(env.DB, uid);
    // 99 открытых одним INSERT … SELECT + 1 обычный — дёшево для сетапа
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 99)
       INSERT INTO loans (user_id, counterparty, direction, amount_minor, currency)
       SELECT ?, 'L' || n, 'owe', 100, 'USD' FROM seq`,
    ).bind(uid).run();
    await addLoan(uid); // 100-й открытый
    // закрытый не занимает лимит
    const closedId = Number((await addLoan(uid, { ...LOAN, counterparty: 'Закрыт' })).meta.last_row_id);
    await repo.closeLoan(closedId);
    const ctx = await ctxOf(uid);
    const r = advanceLoan(st('loan'), { type: 'callback', data: 'ln:add' }, ctx);
    expect(r.state!.step).toBe('loan'); // остались на списке
    expect(r.effects.some((e) => e.kind === 'send' && e.text.includes('100'))).toBe(true);
    expect(r.effects.some((e) => e.kind === 'render')).toBe(false);
  });

  it('stale/чужие колбэки — state без изменений, effects пустые', async () => {
    const uid = await setupUser(OWNER + 85);
    const ctx = await ctxOf(uid);
    const s = st('loan');
    for (const bad of ['ln:rp', 'ln:rp:all', 'ln:dd', 'ln:cl:yes', 'ln:dir:owe', 'ln:hs', 'ln:ev:1', 'ln:', 'dbt:v:1', 'nv:home']) {
      const r = advanceLoan(s, { type: 'callback', data: bad }, ctx);
      expect(r.effects, bad).toEqual([]);
      expect(r.state).toEqual(s);
    }
    expect(advanceLoan(s, { type: 'callback', data: 'ln:v:999' }, ctx).effects).toEqual([]);
  });

  it('возврат: частичный → loan_repay; полный → «возвращён полностью»', async () => {
    const uid = await setupUser(OWNER + 86);
    await addLoan(uid);
    const ctx = await ctxOf(uid);
    const id = ctx.owe[0]!.loan.id;
    // вводим возврат напрямую на шаге loan:repay
    let s = st('loan:repay', { loanId: id });
    const r1 = advanceLoan(s, { type: 'text', text: '100' }, ctx);
    expect(r1.effects.some((e) => e.kind === 'loan_repay' && e.amountMinor === 10_000)).toBe(true);
    // сверх остатка — ошибка
    const r2 = advanceLoan(s, { type: 'text', text: '999' }, ctx);
    expect(r2.effects[0]!.kind).toBe('send');
    expect(r2.effects.some((e) => e.kind === 'loan_repay')).toBe(false);
    // другая валюта — ошибка
    const r3 = advanceLoan(s, { type: 'text', text: '100 rub' }, ctx);
    expect(r3.effects.some((e) => e.kind === 'loan_repay')).toBe(false);
    // полный возврат
    s = st('loan:repay', { loanId: id });
    const r4 = advanceLoan(s, { type: 'text', text: '300' }, ctx);
    expect(r4.effects.some((e) => e.kind === 'render' && e.prefix?.includes('полностью'))).toBe(true);
  });

  it('«💯 Вся сумма» — полный возврат без ввода; «📅 Срок» — смена/сброс даты', async () => {
    const uid = await setupUser(OWNER + 93);
    await addLoan(uid);
    const ctx = await ctxOf(uid);
    const id = ctx.owe[0]!.loan.id;
    // ln:rp:all на шаге loan:repay — loan_repay на весь остаток (300 $ = 30 000 minor)
    const r = advanceLoan(st('loan:repay', { loanId: id }), { type: 'callback', data: 'ln:rp:all' }, ctx);
    expect(r.effects.some((e) => e.kind === 'loan_repay' && e.amountMinor === 30_000)).toBe(true);
    expect(r.effects.some((e) => e.kind === 'render' && e.prefix?.includes('полностью'))).toBe(true);
    // смена срока: карточка → промпт → дата → loan_due
    const s = advanceLoan(st('loan:one', { loanId: id }), { type: 'callback', data: 'ln:dd' }, ctx).state!;
    expect(s.step).toBe('loan:due');
    const bad = advanceLoan(s, { type: 'text', text: 'когда-нибудь' }, ctx);
    expect(bad.effects[0]!.kind).toBe('send');
    expect(bad.effects.some((e) => e.kind === 'loan_due')).toBe(false);
    const r2 = advanceLoan(s, { type: 'text', text: '20.12' }, ctx);
    const due = r2.effects.find((e) => e.kind === 'loan_due');
    expect(due).toBeDefined();
    if (due?.kind === 'loan_due') expect(due.dueOn).toMatch(/-12-20$/);
    // «Без срока» — dueOn: null
    const r3 = advanceLoan(s, { type: 'callback', data: 'ln:dd:none' }, ctx);
    expect(r3.effects.some((e) => e.kind === 'loan_due' && e.dueOn === null)).toBe(true);
    // на закрытом займе кнопки «Срок»/«Возврат» молча не работают
    await scoped(env.DB, uid).closeLoan(id);
    const ctx2 = await ctxOf(uid);
    const r4 = advanceLoan(st('loan:one', { loanId: id }), { type: 'callback', data: 'ln:dd' }, ctx2);
    expect(r4.effects).toEqual([]);
  });

  it('возврат с датой «5000 25.10» → eventOn; битая дата — ошибка; у закрытого «Закрыт: <дата>»', async () => {
    const uid = await setupUser(OWNER + 95);
    await addLoan(uid);
    const ctx = await ctxOf(uid); // ctx.today = '2026-10-20'
    const id = ctx.owe[0]!.loan.id;
    const s = st('loan:repay', { loanId: id });
    // сумма + дата → loan_repay с eventOn
    const r = advanceLoan(s, { type: 'text', text: '100 25.10' }, ctx);
    const rep = r.effects.find((e) => e.kind === 'loan_repay');
    expect(rep).toMatchObject({ amountMinor: 10_000, eventOn: '2026-10-25' });
    // сумма без даты → сегодня
    const r2 = advanceLoan(s, { type: 'text', text: '100' }, ctx);
    expect(r2.effects.find((e) => e.kind === 'loan_repay')).toMatchObject({ eventOn: '2026-10-20' });
    // битая дата → ошибка, события нет
    const r3 = advanceLoan(s, { type: 'text', text: '100 99.99' }, ctx);
    expect(r3.effects[0]!.kind).toBe('send');
    expect(r3.effects.some((e) => e.kind === 'loan_repay')).toBe(false);
    // карточка закрытого займа показывает дату закрытия
    await scoped(env.DB, uid).addLoanEvent({
      loan_id: id,
      amount_minor: 30_000,
      event_on: '2026-10-25',
      source: 'manual',
      source_key: null,
    });
    const ctx3 = await ctxOf(uid);
    const card = renderLoan('LOAN', { loanId: id }, ctx3);
    expect(card.text).toContain('Закрыт: 25.10.2026');
  });

  it('разметка займов не содержит повреждённых символов (U+FFFD)', async () => {
    const uid = await setupUser(OWNER + 96);
    await addLoan(uid);
    const ctx = await ctxOf(uid);
    const id = ctx.owe[0]!.loan.id;
    for (const scr of ['LOANS', 'LOAN', 'LOAN_REPAY', 'LOAN_DUE_EDIT', 'LOAN_CLOSE', 'LOAN_DEL'] as const) {
      const r = renderLoan(scr, { loanId: id }, ctx);
      expect(r.text, scr).not.toContain('�');
      const cbs = (r.markup?.inline_keyboard ?? []).flat();
      for (const b of cbs) expect(b.text, `${scr}: ${b.callback_data}`).not.toContain('�');
    }
  });

  it('закрытие и удаление; cancel target по реестру', async () => {
    const uid = await setupUser(OWNER + 87);
    await addLoan(uid);
    const ctx = await ctxOf(uid);
    const id = ctx.owe[0]!.loan.id;
    let s = advanceLoan(st('loan'), { type: 'callback', data: `ln:v:${id}` }, ctx).state!;
    expect(s.step).toBe('loan:one');
    s = advanceLoan(s, { type: 'callback', data: 'ln:cl' }, ctx).state!;
    expect(s.step).toBe('loan:close');
    const eff = advanceLoan(s, { type: 'callback', data: 'ln:cl:yes' }, ctx).effects;
    expect(eff.some((e) => e.kind === 'loan_close' && e.id === id)).toBe(true);
    s = st('loan:one', { loanId: id });
    s = advanceLoan(s, { type: 'callback', data: 'ln:dl' }, ctx).state!;
    const eff2 = advanceLoan(s, { type: 'callback', data: 'ln:dl:yes' }, ctx).effects;
    expect(eff2.some((e) => e.kind === 'loan_del' && e.id === id)).toBe(true);
    // cancel target: подтверждения/возврат → LOAN, мастер → LOANS
    expect(loanCancelTarget(st('loan:repay', { loanId: id }))).toBe('LOAN');
    expect(loanCancelTarget(st('loan:due', { loanId: id }))).toBe('LOAN');
    expect(loanCancelTarget(st('loan:close', { loanId: id }))).toBe('LOAN');
    expect(loanCancelTarget(st('loan:add:due'))).toBe('LOANS');
    expect(loanCancelTarget(st('loan'))).toBe('HOME');
  });

  it('renderLoan пустого списка и карточка «мне должны»', async () => {
    const uid = await setupUser(OWNER + 88);
    let ctx = await ctxOf(uid);
    expect(renderLoan('LOANS', {}, ctx).text).toContain('Пока пусто');
    await scoped(env.DB, uid).addLoan({ ...LOAN, direction: 'owed', counterparty: 'Петя' });
    ctx = await ctxOf(uid);
    const r = renderLoan('LOAN', { loanId: ctx.owed[0]!.loan.id }, ctx);
    expect(r.text).toContain('мне должны');
    expect(r.text).toContain('Петя');
  });
});

describe('/loans webhook-путь', () => {
  const cbs = () =>
    ((sent.at(-1)!.markup as { inline_keyboard?: { callback_data?: string }[][] })?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data ?? '');

  it('/loans → мастер → заём в БД → карточка → возврат → закрытие → удаление', async () => {
    const uid = await setupUser(OWNER + 89);
    await msg(OWNER + 89, '/loans');
    expect(last()).toContain('Долги');
    expect(cbs()).toContain('ln:add');
    // мастер целиком через webhook
    await cb(OWNER + 89, 'ln:add');
    await cb(OWNER + 89, 'ln:dir:owed');
    await msg(OWNER + 89, 'Петя');
    await msg(OWNER + 89, '20000 rub');
    await cb(OWNER + 89, 'ln:nodue');
    await cb(OWNER + 89, 'ln:nonote');
    expect(last()).toContain('Добавлен: мне должны Петя');
    const rows = (await scoped(env.DB, uid).listLoans()).results;
    expect(rows).toHaveLength(1);
    const l: LoanRow = rows[0]!;
    expect(l).toMatchObject({ counterparty: 'Петя', direction: 'owed', currency: 'RUB' });
    // карточка
    await cb(OWNER + 89, `ln:v:${l.id}`);
    expect(last()).toContain('Петя');
    expect(last()).toContain('20 000');
    // частичный возврат
    await cb(OWNER + 89, 'ln:rp');
    expect(cbs()).toContain('ln:rp:all'); // кнопка «💯 Вся сумма»
    await msg(OWNER + 89, '5000');
    expect(last()).toContain('Внесено');
    expect((await scoped(env.DB, uid).listLoanEvents(l.id)).results).toHaveLength(1);
    // «передоговорились»: смена срока через 📅
    await cb(OWNER + 89, 'ln:dd');
    await msg(OWNER + 89, '20.12');
    expect(last()).toContain('Новый срок');
    expect((await scoped(env.DB, uid).getLoan(l.id))!.due_on).toMatch(/-12-20$/);
    // закрытие с остатком — confirm
    await cb(OWNER + 89, 'ln:cl');
    expect(last()).toContain('будет прощён');
    await cb(OWNER + 89, 'ln:cl:yes');
    expect(last()).toContain('Закрыт');
    expect((await scoped(env.DB, uid).getLoan(l.id))!.closed_at).not.toBeNull();
    // удаление
    await cb(OWNER + 89, 'ln:dl');
    await cb(OWNER + 89, 'ln:dl:yes');
    expect(last()).toContain('Удалён: Петя');
    expect((await scoped(env.DB, uid).listLoans()).results).toHaveLength(0);
  });

  it('журнал возвратов: правка суммы и удаление события по webhook', async () => {
    const uid = await setupUser(OWNER + 96);
    await addLoan(uid);
    const l = (await scoped(env.DB, uid).listLoans()).results[0]!;
    await msg(OWNER + 96, '/loans');
    await cb(OWNER + 96, `ln:v:${l.id}`);
    await cb(OWNER + 96, 'ln:rp');
    await msg(OWNER + 96, '100 05.02');
    const evId = (await scoped(env.DB, uid).listLoanEvents(l.id)).results[0]!.id;
    // журнал → событие → правка суммы
    await cb(OWNER + 96, 'ln:hs');
    expect(last()).toContain('Журнал');
    await cb(OWNER + 96, `ln:ev:${evId}`);
    expect(last()).toContain('Возврат');
    await cb(OWNER + 96, `ln:ev:e:${evId}`);
    await msg(OWNER + 96, '150');
    expect(last()).toContain('Записано');
    expect((await scoped(env.DB, uid).getLoanEvent(evId))?.amount_minor).toBe(15_000);
    // удаление с подтверждением → остаток вернулся
    await cb(OWNER + 96, `ln:ev:d:${evId}`);
    await cb(OWNER + 96, `ln:ev:dy:${evId}`);
    expect(last()).toContain('удалён');
    expect((await scoped(env.DB, uid).listLoanEvents(l.id)).results).toHaveLength(0);
    const v = await loanView(scoped(env.DB, uid), (await scoped(env.DB, uid).getLoan(l.id))!);
    expect(v.remaining).toBeCloseTo(300, 2);
  });

  it('«💯 Вся сумма» по webhook: полное событие возврата → заём закрыт', async () => {
    const uid = await setupUser(OWNER + 94);
    await addLoan(uid);
    const l = (await scoped(env.DB, uid).listLoans()).results[0]!;
    await msg(OWNER + 94, '/loans');
    await cb(OWNER + 94, `ln:v:${l.id}`);
    await cb(OWNER + 94, 'ln:rp');
    await cb(OWNER + 94, 'ln:rp:all');
    expect(last()).toContain('возвращён полностью');
    const evs = (await scoped(env.DB, uid).listLoanEvents(l.id)).results;
    expect(evs).toHaveLength(1);
    expect(evs[0]!.amount_minor).toBe(30_000);
    const v = await loanView(scoped(env.DB, uid), (await scoped(env.DB, uid).getLoan(l.id))!);
    expect(v.status).toBe('closed');
  });

  it('изоляция: чужой loan id не открывается и не изменяется', async () => {
    const uidA = await setupUser(OWNER + 90);
    await setupUser(OWNER + 91);
    await addLoan(uidA, { ...LOAN, counterparty: 'Чужой Вася' });
    const idA = (await scoped(env.DB, uidA).listLoans()).results[0]!.id;
    await msg(OWNER + 91, '/loans');
    const n = sent.length;
    await cb(OWNER + 91, `ln:v:${idA}`); // чужой id — молча
    expect(sent.length).toBe(n);
    await cb(OWNER + 91, 'ln:rp'); // не на loan:one — молча
    expect(sent.length).toBe(n);
    await cb(OWNER + 91, 'ln:cl:yes'); // не на loan:close — молча
    expect(sent.length).toBe(n);
    const la = (await scoped(env.DB, uidA).getLoan(idA))!;
    expect(la.closed_at).toBeNull();
    expect((await scoped(env.DB, uidA).listLoanEvents(idA)).results).toHaveLength(0);
  });

  it('stale ln-колбэк на чужом шаге молча игнорируется', async () => {
    await setupUser(OWNER + 92);
    await msg(OWNER + 92, '⚙️ Профиль'); // шаг pf:*
    const n = sent.length;
    await cb(OWNER + 92, 'ln:add');
    await cb(OWNER + 92, 'ln:dl:yes');
    expect(sent.length).toBe(n);
  });
});
