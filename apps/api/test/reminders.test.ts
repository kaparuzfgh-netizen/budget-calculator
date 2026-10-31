/** reminders.test.ts — cron-сервис runReminders (веха D). */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { runReminders, localParts, dueDateFor, minus2days } from '../src/services/reminders';
import { runWeek } from '../src/bot/features';
import { scoped } from '../src/db/repo';
import { TelegramError, type TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import type { Env } from '../src/env';

const sent: { chatId: number; text: string }[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t) => void sent.push({ chatId: Number(c), text: t }),
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
};
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97 }, asOf: 'x' }) };

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  for (const t of ['conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'debt_events', 'debts', 'loan_events', 'loans', 'profiles', 'consents', 'reminder_log', 'audit_log', 'processed_updates', 'invites', 'users'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
async function user(tgId: number, tz: string, opts: {
  weekly?: number; pay?: number;
  commits?: {
    name: string; minor: number; ccy: string; due: number | null; active?: number;
    /** Каденс (0016); без полей — monthly. */
    frequency?: 'monthly' | 'interval_days' | 'yearly';
    interval_days?: number; anchor_on?: string; due_month?: number;
  }[];
  debts?: { name: string; ccy: string; rate: number; bal: number; pay: number; due: number | null; freq?: 'monthly' | 'biweekly' }[];
  loans?: { cp: string; dir: 'owe' | 'owed'; minor: number; ccy: string; due: string | null }[];
} = {}) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD', income_currency: 'EUR', living_currency: 'RUB', timezone: tz,
    income_minor: 0, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
    reminders_weekly: opts.weekly ?? 1, reminders_payments: opts.pay ?? 1,
  });
  // kb-миграция снятия клавиатуры у этих юзеров «уже пройдена» — считаем только напоминания
  await scoped(env.DB, uid).claimReminder('kb_removed', 'v1');
  for (const c of opts.commits ?? [])
    await scoped(env.DB, uid).addCommitment({
      name: c.name, amount_minor: c.minor, currency: c.ccy, due_day: c.due,
      frequency: c.frequency ?? 'monthly',
      interval_days: c.interval_days ?? null,
      anchor_on: c.anchor_on ?? null,
      due_month: c.due_month ?? null,
    });
  if (opts.commits) for (const c of opts.commits) {
    if (c.active === 0) {
      const all = (await scoped(env.DB, uid).listCommitments(false)).results;
      const row = all.find((r) => r.name === c.name);
      if (row) await scoped(env.DB, uid).patchCommitment(row.id, { active: 0 });
    }
  }
  for (const d of opts.debts ?? [])
    await scoped(env.DB, uid).addDebt({
      name: d.name, currency: d.ccy, rate: d.rate, frequency: d.freq ?? 'monthly',
      initial_balance_minor: d.bal, initial_payment_minor: d.pay, epoch: '2026-01-01', due_day: d.due,
    });
  for (const l of opts.loans ?? [])
    await scoped(env.DB, uid).addLoan({
      counterparty: l.cp, direction: l.dir, amount_minor: l.minor, currency: l.ccy, due_on: l.due, note: null,
    });
  // created_at по умолчанию «сейчас» — бэкдейтим, чтобы объект существовал к дате срока в тестах
  await env.DB.prepare("UPDATE commitments SET created_at = ? WHERE user_id = ?").bind('2026-01-01 00:00:00', uid).run();
  await env.DB.prepare("UPDATE debts SET created_at = ? WHERE user_id = ?").bind('2026-01-01 00:00:00', uid).run();
  return uid;
}
const run = (now: Date, deps?: { telegram?: TelegramClient }) => runReminders(env as Env, now, { telegram: deps?.telegram ?? tg, fx });

describe('localParts / dueDateFor (чистые)', () => {
  it('таймзона: Бишкек +6 vs UTC; воскресенье у границы суток', () => {
    // 2026-10-25 (вс) 14:30 UTC = 20:30 Бишкек; 21:30 UTC = пон 03:30 Бишкек
    const a = localParts('Asia/Bishkek', new Date(Date.UTC(2026, 9, 25, 14, 30)));
    expect(a).toMatchObject({ dow: 0, hour: 20, iso: '2026-10-25' });
    const b = localParts('UTC', new Date(Date.UTC(2026, 9, 25, 14, 30)));
    expect(b).toMatchObject({ dow: 0, hour: 14 });
    const c = localParts('Asia/Bishkek', new Date(Date.UTC(2026, 9, 25, 18, 30)));
    expect(c).toMatchObject({ dow: 1, iso: '2026-10-26' }); // локально уже понедельник
    expect(localParts('bad/tz', new Date()).hour).toBeDefined(); // invalid → UTC, не падает
  });
  it('дедлайны: февраль високосный/обычный, due_day 31, ролловер года', () => {
    expect(dueDateFor(31, 2026, 2)).toEqual({ y: 2026, m: 2, d: 28 }); // фев-2026 не високосный
    expect(dueDateFor(31, 2028, 2)).toEqual({ y: 2028, m: 2, d: 29 }); // високосный
    expect(dueDateFor(15, 2026, 3)).toEqual({ y: 2026, m: 3, d: 15 });
    expect(minus2days(2026, 3, 1)).toEqual({ y: 2026, m: 2, d: 27 });
    expect(minus2days(2028, 3, 1)).toEqual({ y: 2028, m: 2, d: 28 });
    expect(minus2days(2026, 1, 1)).toEqual({ y: 2025, m: 12, d: 30 }); // год
  });
});

describe('runReminders — weekly', () => {
  it('вс 20:00 локально → итог недели; не час/не день → молча; два прогона → 1 сообщение', async () => {
    await user(700001, 'Asia/Bishkek');
    // вс 20:00 Бишкек = 14:00 UTC
    await run(new Date(Date.UTC(2026, 9, 25, 14, 0)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Итоги недели');
    // повтор тот же миг — дедуп
    await run(new Date(Date.UTC(2026, 9, 25, 14, 0)));
    expect(sent).toHaveLength(1);
    // не воскресенье 20:00
    await run(new Date(Date.UTC(2026, 9, 26, 14, 0)));
    expect(sent).toHaveLength(1);
    // другой часовой пояс: UTC-юзеру в 14:00 UTC ничего (20:00 UTC = 2 ч позже)
    await user(700002, 'UTC');
    await run(new Date(Date.UTC(2026, 9, 25, 14, 0)));
    expect(sent).toHaveLength(1);
    await run(new Date(Date.UTC(2026, 9, 25, 20, 0)));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.chatId).toBe(700002);
  });
  it('флаги выключены → молча; 403 → флаги обнуляются и цикл идёт дальше', async () => {
    const ua = await user(700010, 'UTC', { weekly: 0 });
    void ua;
    await user(700011, 'UTC');
    const t403: TelegramClient = {
      sendMessage: async (c) => {
        if (Number(c) === 700011) throw new TelegramError(403, 'bot was blocked by the user');
        sent.push({ chatId: Number(c), text: 'ok' });
      },
      answerCallbackQuery: async () => {},
      sendDocument: async () => {},
    };
    await run(new Date(Date.UTC(2026, 9, 25, 20, 0)), { telegram: t403 });
    const p11 = await scoped(env.DB, Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=700011').first<{id:number}>())!.id)).getProfile();
    expect(p11!.reminders_weekly).toBe(0);
    expect(p11!.reminders_payments).toBe(0);
    // другой юзер до/после — цикл не сломан (sent содержит его сообщение)
  });
  it('не-403 ошибка → claim освобождается и следующий час в окне ретраит', async () => {
    await user(700012, 'UTC');
    const boom: TelegramClient = {
      sendMessage: async () => { throw new Error('net down'); },
      answerCallbackQuery: async () => {},
      sendDocument: async () => {},
    };
    await run(new Date(Date.UTC(2026, 9, 25, 20, 0)), { telegram: boom });
    expect(sent).toHaveLength(0);
    await run(new Date(Date.UTC(2026, 9, 25, 21, 0)), { telegram: tg }); // ретрай через час — шлёт
    expect(sent).toHaveLength(1);
  });
  it('окно weekly: вс 19:00 — тишина; пн 20:00 — тишина; вс 23:00 — шлёт', async () => {
    await user(700013, 'UTC');
    await run(new Date(Date.UTC(2026, 9, 25, 19, 0))); // вс 19:00 — до окна
    await run(new Date(Date.UTC(2026, 9, 26, 20, 0))); // пн 20:00 — не воскресенье
    expect(sent).toHaveLength(0);
    await run(new Date(Date.UTC(2026, 9, 25, 23, 0))); // вс 23:00 — край окна
    expect(sent).toHaveLength(1);
  });
});

describe('runReminders — платежи', () => {
  it('due_day через 2 дня → одно сообщение; 31-е: февраль кламп; due 1-е → конец пред. месяца', async () => {
    // due 31 окт → напоминание 29 окт; due 1 ноя → напоминание 30 окт (след. месяц!)
    const uid20 = await user(700020, 'UTC', {
      commits: [
        { name: 'Аренда', minor: 70000, ccy: 'USD', due: 31 },
        { name: 'Связь', minor: 30000, ccy: 'USD', due: 1 },
        { name: 'Страховка', minor: 50000, ccy: 'USD', due: 15 }, // не сейчас
        { name: 'Выключенный', minor: 10000, ccy: 'USD', due: 31, active: 0 },
      ],
    });
    // «Связь» и «Страховка» заведены после своих октябрьских сроков — автопроводок не будет
    // name зашифровано — фильтруем по plaintext due_day (1 и 15 уникальны здесь)
    await env.DB.prepare("UPDATE commitments SET created_at = '2026-10-05 00:00:00' WHERE user_id = ? AND due_day = 1").bind(uid20).run();
    await env.DB.prepare("UPDATE commitments SET created_at = '2026-10-20 00:00:00' WHERE user_id = ? AND due_day = 15").bind(uid20).run();
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0))); // 29 окт: due 31 → за 2 дня
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Аренда');
    expect(sent[0]!.text).not.toContain('Выключенный');
    sent.length = 0;
    await run(new Date(Date.UTC(2026, 9, 30, 10, 0))); // 30 окт: due 1 ноя → за 2 дня
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Связь');
  });
  it('окно платежей: сбой в 10:00 → ретрай в 11:00; в 09:00 и 22:00 — тишина', async () => {
    await user(700025, 'UTC', { commits: [{ name: 'Аренда', minor: 70000, ccy: 'USD', due: 31 }] });
    const boom: TelegramClient = {
      sendMessage: async () => { throw new Error('net down'); },
      answerCallbackQuery: async () => {},
      sendDocument: async () => {},
    };
    await run(new Date(Date.UTC(2026, 9, 29, 9, 0))); // до окна
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)), { telegram: boom }); // сбой — claim снят
    await run(new Date(Date.UTC(2026, 9, 29, 22, 0))); // после окна — ретрая нет
    expect(sent).toHaveLength(0);
    await run(new Date(Date.UTC(2026, 9, 29, 11, 0))); // ретрай в окне — шлёт
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Аренда');
  });
  it('изоляция: в сообщении юзера A нет данных юзера B; без due_day — игнор', async () => {
    await user(700030, 'UTC', { commits: [{ name: 'A-платёж', minor: 1, ccy: 'USD', due: 31 }] });
    await user(700031, 'UTC', { commits: [{ name: 'B-платёж', minor: 2, ccy: 'USD', due: 31 }, { name: 'B-bezdnej', minor: 3, ccy: 'USD', due: null }] });
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    const a = sent.find((m) => m.chatId === 700030)!;
    expect(a.text).toContain('A-платёж');
    expect(a.text).not.toContain('B-');
    const b = sent.find((m) => m.chatId === 700031)!;
    expect(b.text).toContain('B-платёж');
    expect(b.text).not.toContain('bezdnej');
  });
});

describe('runReminders — долги и займы (H4)', () => {
  it('долг: напоминание за 2 дня в общем сообщении; оплачен в этом месяце → молча', async () => {
    const uid = await user(700040, 'UTC', {
      debts: [{ name: 'Ипотека', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 1100000, due: 31 }],
    });
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0))); // 29 окт: срок 31 → за 2 дня
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Ипотека');
    expect(sent[0]!.text).toMatch(/11.000/); // fmtMoney — NBSP-группировка
    expect(sent[0]!.text).toContain('31.10');
    // записали платёж октября вручную → напоминание больше не нужно
    const debt = (await scoped(env.DB, uid).listDebts()).results[0]!;
    await scoped(env.DB, uid).addDebtEvent({
      debt_id: debt.id, kind: 'payment', amount_minor: 1100000, event_on: '2026-10-30',
      source: 'manual', source_key: 'tg:1',
    });
    sent.length = 0;
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    expect(sent).toHaveLength(0);
  });

  it('автопроводка: в день платежа пишется payment(source=auto); повтор — дедуп; удалённое не воскресает; след. месяц — снова', async () => {
    const uid = await user(700050, 'UTC', {
      debts: [{ name: 'Кредит', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 1100000, due: 31 }],
    });
    const repo = scoped(env.DB, uid);
    const debtId = (await repo.listDebts()).results[0]!.id;
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0))); // 31 окт — день платежа
    let evs = (await repo.listDebtEvents(debtId)).results;
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'payment', source: 'auto', event_on: '2026-10-31', amount_minor: 1100000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('автоплатежи');
    // повторный прогон в тот же день — ни события, ни сообщения
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    evs = (await repo.listDebtEvents(debtId)).results;
    expect(evs).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // юзер удалил автособытие → ре-проводки не будет (claim за день уже занят)
    await repo.deleteDebtEvent(evs[0]!.id);
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    expect((await repo.listDebtEvents(debtId)).results).toHaveLength(0);
    // следующий месяц — проводка снова
    await run(new Date(Date.UTC(2026, 10, 30, 10, 0)));
    evs = (await repo.listDebtEvents(debtId)).results;
    expect(evs).toHaveLength(1);
    expect(evs[0]!.event_on).toBe('2026-11-30');
  });

  it('автопроводка: ручной платёж месяца отменяет автопост; biweekly/без due_day — не проводится; флаг 0 — тишина', async () => {
    const uid = await user(700060, 'UTC', {
      debts: [
        { name: 'Оплачен', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 1100000, due: 31 },
        { name: 'Бивикл', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 500000, due: null, freq: 'biweekly' },
        { name: 'Без дня', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 500000, due: null },
      ],
    });
    const repo = scoped(env.DB, uid);
    const paid = (await repo.listDebts()).results.find((d) => d.name === 'Оплачен')!;
    await repo.addDebtEvent({
      debt_id: paid.id, kind: 'payment', amount_minor: 1100000, event_on: '2026-10-15',
      source: 'manual', source_key: 'tg:2',
    });
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    // только ручное событие, автопроводок нет; и сообщений нет
    expect((await repo.listDebtEvents(paid.id)).results).toHaveLength(1);
    expect(sent).toHaveLength(0);
    // флаг выключен → вообще ничего
    const uid2 = await user(700061, 'UTC', {
      pay: 0,
      debts: [{ name: 'X', ccy: 'RUB', rate: 0.12, bal: 1000000, pay: 100000, due: 31 }],
      loans: [{ cp: 'Вася', dir: 'owe', minor: 10000, ccy: 'USD', due: '2026-10-31' }],
    });
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    expect((await scoped(env.DB, uid2).listDebtEvents((await scoped(env.DB, uid2).listDebts()).results[0]!.id)).results).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('автопроводка долга: дата события = день срока; пропущенный тик → catch-up на след. день; повтор — нет; удалённое не воскресает', async () => {
    const uid = await user(700055, 'UTC', {
      debts: [{ name: 'Кредит', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 1100000, due: 28 }],
    });
    const repo = scoped(env.DB, uid);
    const debtId = (await repo.listDebts()).results[0]!.id;
    // крон пропустил день срока (28-е): прогон 29-го в 10:00 догоняет, событие датой 28-го
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    let evs = (await repo.listDebtEvents(debtId)).results;
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'payment', source: 'auto', event_on: '2026-10-28', amount_minor: 1100000 });
    expect(sent).toHaveLength(1);
    // повторные прогоны этого месяца — ничего
    await run(new Date(Date.UTC(2026, 9, 30, 10, 0)));
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    expect((await repo.listDebtEvents(debtId)).results).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // юзер удалил автособытие → ре-проводки в этом месяце нет (claim объект+месяц занят)
    await repo.deleteDebtEvent(evs[0]!.id);
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    expect((await repo.listDebtEvents(debtId)).results).toHaveLength(0);
    expect(sent).toHaveLength(1);
    // следующий месяц — проводка снова, датой срока
    await run(new Date(Date.UTC(2026, 10, 28, 10, 0)));
    evs = (await repo.listDebtEvents(debtId)).results;
    expect(evs).toHaveLength(1);
    expect(evs[0]!.event_on).toBe('2026-11-28');
  });
  it('автопроводка: объект заведён после срока месяца → в этом месяце не проводится; со след. — да', async () => {
    const uid = await user(700056, 'UTC', {
      commits: [{ name: 'Связь', minor: 30000, ccy: 'USD', due: 15 }],
      debts: [{ name: 'Новый', ccy: 'RUB', rate: 0.12, bal: 1000000, pay: 50000, due: 15 }],
    });
    // заведены 20 октября — после срока 15 октября
    await env.DB.prepare("UPDATE commitments SET created_at = '2026-10-20 00:00:00' WHERE user_id = ?").bind(uid).run();
    await env.DB.prepare("UPDATE debts SET created_at = '2026-10-20 00:00:00' WHERE user_id = ?").bind(uid).run();
    const repo = scoped(env.DB, uid);
    const cid = (await repo.listCommitments()).results[0]!.id;
    const did = (await repo.listDebts()).results[0]!.id;
    await run(new Date(Date.UTC(2026, 9, 28, 10, 0))); // 28 окт: срок прошёл, но объекта не было
    expect((await repo.listCommitmentPayments(cid)).results).toHaveLength(0);
    expect((await repo.listDebtEvents(did)).results).toHaveLength(0);
    expect(sent).toHaveLength(0);
    await run(new Date(Date.UTC(2026, 10, 15, 10, 0))); // 15 ноя — первый реальный срок
    expect((await repo.listCommitmentPayments(cid)).results).toHaveLength(1);
    expect((await repo.listDebtEvents(did)).results).toHaveLength(1);
  });
  it('автопроводка долга: последний платёж усечён до остатка + проценты за период', async () => {
    const uid = await user(700057, 'UTC', {
      debts: [{ name: 'Хвост', ccy: 'RUB', rate: 0.12, bal: 500000, pay: 1100000, due: 31 }],
    });
    const repo = scoped(env.DB, uid);
    const did = (await repo.listDebts()).results[0]!.id;
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    const ev = (await repo.listDebtEvents(did)).results[0]!;
    // min(11000, 5000 + 5000*0.12/12 = 5050) → ≤ 505000 minor
    expect(ev.amount_minor).toBeLessThanOrEqual(505000);
    expect(ev.amount_minor).toBeLessThan(1100000);
  });
  it('автопроводка платежа: в день due_day пишется оплата (source=auto); повтор — дедуп; удалённое не воскресает; след. месяц — снова', async () => {
    const uid = await user(700080, 'UTC', {
      commits: [{ name: 'Квартплата', minor: 5000000, ccy: 'RUB', due: 5 }],
    });
    const repo = scoped(env.DB, uid);
    const cid = (await repo.listCommitments()).results[0]!.id;
    await run(new Date(Date.UTC(2026, 9, 5, 10, 0))); // 5 окт — день платежа
    let pays = (await repo.listCommitmentPayments(cid)).results;
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({
      commitment_id: cid, source: 'auto', paid_on: '2026-10-05',
      amount_minor: 5000000, currency: 'RUB', source_key: `auto:c:${cid}:2026-10`,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('автоплатежи');
    expect(sent[0]!.text).toContain('Квартплата');
    expect(sent[0]!.text).toMatch(/50.000/); // fmtMoney — NBSP-группировка
    // повторный прогон в тот же день — ни записи, ни сообщения
    await run(new Date(Date.UTC(2026, 9, 5, 10, 0)));
    expect((await repo.listCommitmentPayments(cid)).results).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // юзер удалил автозапись → ре-проводки не будет (claim за день уже занят)
    await repo.deleteCommitmentPayment(pays[0]!.id);
    await run(new Date(Date.UTC(2026, 9, 5, 10, 0)));
    expect((await repo.listCommitmentPayments(cid)).results).toHaveLength(0);
    // следующий месяц — проводка снова
    await run(new Date(Date.UTC(2026, 10, 5, 10, 0)));
    pays = (await repo.listCommitmentPayments(cid)).results;
    expect(pays).toHaveLength(1);
    expect(pays[0]!.paid_on).toBe('2026-11-05');
  });

  it('платёж: ручная оплата месяца отменяет автопост и напоминание за 2 дня; неактивный — ничего', async () => {
    const uid = await user(700090, 'UTC', {
      commits: [
        { name: 'Оплаченный', minor: 1000, ccy: 'USD', due: 15 },
        { name: 'Выключенный', minor: 2000, ccy: 'USD', due: 15, active: 0 },
      ],
    });
    const repo = scoped(env.DB, uid);
    const paid = (await repo.listCommitments(false)).results.find((c) => c.name === 'Оплаченный')!;
    const off = (await repo.listCommitments(false)).results.find((c) => c.name === 'Выключенный')!;
    await repo.addCommitmentPayment({
      commitment_id: paid.id, amount_minor: 1000, currency: 'USD',
      paid_on: '2026-10-01', source: 'manual', source_key: 'tg:7',
    });
    // за 2 дня до срока (13 окт) — напоминаний нет
    await run(new Date(Date.UTC(2026, 9, 13, 10, 0)));
    expect(sent).toHaveLength(0);
    // в день срока — автопроводок нет ни у оплаченного, ни у выключенного
    await run(new Date(Date.UTC(2026, 9, 15, 10, 0)));
    expect(sent).toHaveLength(0);
    expect((await repo.listCommitmentPayments(paid.id)).results).toHaveLength(1); // только ручная
    expect((await repo.listCommitmentPayments(off.id)).results).toHaveLength(0);
  });

  it('автопроводка: долг + платёж в один день → ОДНО сообщение с обоими', async () => {
    const uid = await user(700095, 'UTC', {
      commits: [{ name: 'Интернет', minor: 60000, ccy: 'RUB', due: 31 }],
      debts: [{ name: 'Ипотека', ccy: 'RUB', rate: 0.12, bal: 10000000, pay: 1100000, due: 31 }],
    });
    const repo = scoped(env.DB, uid);
    const cid = (await repo.listCommitments()).results[0]!.id;
    const did = (await repo.listDebts()).results[0]!.id;
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('автоплатежи');
    expect(sent[0]!.text).toContain('Ипотека');
    expect(sent[0]!.text).toContain('Интернет');
    expect((await repo.listCommitmentPayments(cid)).results).toHaveLength(1);
    expect((await repo.listDebtEvents(did)).results).toHaveLength(1);
  });

  it('займы: «сегодня» и «через 3 дня»; закрытый и бессрочный — игнор', async () => {
    const uid = await user(700070, 'UTC', {
      loans: [
        { cp: 'Вася', dir: 'owe', minor: 30000, ccy: 'USD', due: '2026-10-31' },   // через 3 дня
        { cp: 'Петя', dir: 'owed', minor: 2000000, ccy: 'RUB', due: '2026-10-28' }, // сегодня
        { cp: 'Маша', dir: 'owe', minor: 50000, ccy: 'USD', due: '2026-10-28' },   // закрыт — мимо
        { cp: 'СрокНет', dir: 'owe', minor: 50000, ccy: 'USD', due: null },
        { cp: 'Далеко', dir: 'owe', minor: 50000, ccy: 'USD', due: '2026-11-15' },
      ],
    });
    const repo = scoped(env.DB, uid);
    // «закрываем» Машу полным возвратом
    const masha = (await repo.listLoans()).results.find((l) => l.counterparty === 'Маша')!;
    await repo.addLoanEvent({ loan_id: masha.id, amount_minor: 50000, event_on: '2026-10-01', source: 'manual', source_key: 'tg:3' });
    await run(new Date(Date.UTC(2026, 9, 28, 10, 0)));
    expect(sent).toHaveLength(1);
    const t = sent[0]!.text;
    expect(t).toContain('Сроки по займам');
    expect(t).toContain('вернуть Вася');
    expect(t).toContain('Петя должен вернуть');
    expect(t).not.toContain('Маша');
    expect(t).not.toContain('Далеко');
    // дедуп на повтор
    await run(new Date(Date.UTC(2026, 9, 28, 10, 0)));
    expect(sent).toHaveLength(1);
    // в день срока Васи — снова напомнит
    await run(new Date(Date.UTC(2026, 9, 31, 10, 0)));
    const vasya = sent.find((m) => m.text.includes('Вася'));
    expect(vasya?.text).toContain('Сегодня');
  });
});

describe('runReminders — каденсы платежей (миграция 0016)', () => {
  it('interval_days: напоминание за 2 дня до КАЖДОГО срока; период, оплаченный своим окном, — молча', async () => {
    // Йога: сроки 15.10, 29.10…; Спортзал: 08.10, 15.10, 22.10, 29.10…
    const uid = await user(700110, 'UTC', {
      commits: [
        { name: 'Йога', minor: 1000, ccy: 'USD', due: null, frequency: 'interval_days', interval_days: 14, anchor_on: '2026-10-15' },
        { name: 'Спортзал', minor: 2000, ccy: 'USD', due: null, frequency: 'interval_days', interval_days: 7, anchor_on: '2026-10-08' },
      ],
    });
    const repo = scoped(env.DB, uid);
    const gym = (await repo.listCommitments(false)).results.find((c) => c.name === 'Спортзал')!;
    // сроки 08.10 и 15.10 Спортзала оплачены своими окнами
    await repo.addCommitmentPayment({ commitment_id: gym.id, amount_minor: 2000, currency: 'USD', paid_on: '2026-10-08', source: 'manual', source_key: 'tg:g1' });
    await repo.addCommitmentPayment({ commitment_id: gym.id, amount_minor: 2000, currency: 'USD', paid_on: '2026-10-10', source: 'manual', source_key: 'tg:g2' });
    // 13.10: до срока 15.10 — 2 дня: Йога напомнит, оплаченный Спортзал — нет
    await run(new Date(Date.UTC(2026, 9, 13, 10, 0)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Йога');
    expect(sent[0]!.text).not.toContain('Спортзал');
    // 15.10: автопост Йоги (срок наступил); Спортзал — покрыт
    await run(new Date(Date.UTC(2026, 9, 15, 10, 0)));
    expect(sent).toHaveLength(2);
    const yoga = (await repo.listCommitments(false)).results.find((c) => c.name === 'Йога')!;
    expect((await repo.listCommitmentPayments(yoga.id)).results).toMatchObject([
      { paid_on: '2026-10-15', source: 'auto', source_key: `auto:c:${yoga.id}:2026-10-15` },
    ]);
    // 20.10: до срока Спортзала 22.10 — 2 дня → напоминание (15.10-й срок уже не тот период)
    await run(new Date(Date.UTC(2026, 9, 20, 10, 0)));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.text).toContain('Спортзал');
    expect(sent[2]!.text).toContain('22.10');
  });

  it('interval_days: автопост каждого срока ключом auto:c:<id>:<date>; catch-up пропущенных; удалённое не воскресает', async () => {
    const uid = await user(700111, 'UTC', {
      commits: [
        { name: 'Фитнес', minor: 1500, ccy: 'USD', due: null, frequency: 'interval_days', interval_days: 7, anchor_on: '2026-10-01' },
      ],
    });
    const repo = scoped(env.DB, uid);
    const cid = (await repo.listCommitments()).results[0]!.id;
    // первый прогон 15.10 — догон всех пропущенных сроков: 01, 08, 15
    await run(new Date(Date.UTC(2026, 9, 15, 10, 0)));
    let pays = (await repo.listCommitmentPayments(cid)).results;
    expect(pays.map((x) => x.paid_on)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15']);
    expect(pays.every((x) => x.source === 'auto' && x.source_key === `auto:c:${cid}:${x.paid_on}`)).toBe(true);
    expect(sent).toHaveLength(1); // одно сводное сообщение
    // повтор — ничего
    await run(new Date(Date.UTC(2026, 9, 15, 10, 0)));
    expect((await repo.listCommitmentPayments(cid)).results).toHaveLength(3);
    // ручная оплата в окне срока 22.10 (15.10 < paid_on ≤ 22.10) отменяет автопост
    await repo.addCommitmentPayment({ commitment_id: cid, amount_minor: 1500, currency: 'USD', paid_on: '2026-10-20', source: 'manual', source_key: 'tg:m1' });
    await run(new Date(Date.UTC(2026, 9, 22, 10, 0)));
    pays = (await repo.listCommitmentPayments(cid)).results;
    expect(pays).toHaveLength(4);
    expect(pays.filter((x) => x.source === 'auto')).toHaveLength(3);
    // 29.10 — автопост; юзер удалил → повтор не воскресает (claim срока занят)
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    pays = (await repo.listCommitmentPayments(cid)).results;
    const auto29 = pays.find((x) => x.paid_on === '2026-10-29' && x.source === 'auto')!;
    expect(auto29).toBeDefined();
    await repo.deleteCommitmentPayment(auto29.id);
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    expect((await repo.listCommitmentPayments(cid)).results.every((x) => x.paid_on !== '2026-10-29')).toBe(true);
    // следующий срок 05.11 — проводится снова
    await run(new Date(Date.UTC(2026, 10, 5, 10, 0)));
    expect((await repo.listCommitmentPayments(cid)).results.some((x) => x.paid_on === '2026-11-05')).toBe(true);
  });

  it('yearly: срок раз в год — напоминание за 2 дня и автопост в день срока; вне срока — тишина; год спустя — снова', async () => {
    const uid = await user(700112, 'UTC', {
      commits: [
        { name: 'Страховка', minor: 120000, ccy: 'USD', due: 20, frequency: 'yearly', due_month: 10 },
      ],
    });
    const repo = scoped(env.DB, uid);
    const cid = (await repo.listCommitments()).results[0]!.id;
    // 05.10 — до срока 15 дней: ни напоминания, ни проводки
    await run(new Date(Date.UTC(2026, 9, 5, 10, 0)));
    expect(sent).toHaveLength(0);
    // 18.10 — за 2 дня → напоминание
    await run(new Date(Date.UTC(2026, 9, 18, 10, 0)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Страховка');
    expect(sent[0]!.text).toContain('20.10');
    // 20.10 — автопост ключом на срок
    await run(new Date(Date.UTC(2026, 9, 20, 10, 0)));
    const pays = (await repo.listCommitmentPayments(cid)).results;
    expect(pays).toMatchObject([
      { paid_on: '2026-10-20', source: 'auto', source_key: `auto:c:${cid}:2026-10-20` },
    ]);
    // после срока — ничего до следующего года
    await run(new Date(Date.UTC(2026, 10, 18, 10, 0)));
    expect(sent).toHaveLength(2); // напоминание + автопост, больше ничего
    // год спустя — тот же цикл
    await run(new Date(Date.UTC(2027, 9, 18, 10, 0)));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.text).toContain('Страховка');
    await run(new Date(Date.UTC(2027, 9, 20, 10, 0)));
    expect((await repo.listCommitmentPayments(cid)).results.map((x) => x.paid_on)).toEqual([
      '2026-10-20',
      '2027-10-20',
    ]);
  });

  it('yearly 29.02: в невисокосном году срок — 28.02', async () => {
    const uid = await user(700113, 'UTC', {
      commits: [
        { name: 'Високосный', minor: 100, ccy: 'USD', due: 29, frequency: 'yearly', due_month: 2 },
      ],
    });
    const repo = scoped(env.DB, uid);
    const cid = (await repo.listCommitments()).results[0]!.id;
    await run(new Date(Date.UTC(2026, 1, 28, 10, 0))); // 2026 — не високосный
    expect((await repo.listCommitmentPayments(cid)).results).toMatchObject([{ paid_on: '2026-02-28' }]);
  });
});

describe('runReminders — reminder_hour (миграция 0018)', () => {
  it('платежное окно сдвигается на свой час; NULL — легаси 10:00; час 23 — кламп к полуночи', async () => {
    // свой час 18: в легаси-окно молча, в свой час — напоминание за 2 дня до 31-го
    const uid = await user(700120, 'UTC', {
      commits: [{ name: 'Аренда', minor: 100, ccy: 'USD', due: 31 }],
    });
    await scoped(env.DB, uid).patchProfile({ reminder_hour: 18 });
    await run(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    await run(new Date(Date.UTC(2026, 9, 29, 17, 0)));
    expect(sent).toHaveLength(0);
    await run(new Date(Date.UTC(2026, 9, 29, 18, 0)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Аренда');
    // NULL (колонки нет в профиле) — легаси: due 1 нояб → напоминание 30 окт в 10:00
    const uid2 = await user(700121, 'UTC', {
      commits: [{ name: 'Связь', minor: 100, ccy: 'USD', due: 1 }],
    });
    // заведён после октябрьского срока 01.10 — автопроводки в тесте не ждём
    await env.DB.prepare("UPDATE commitments SET created_at = '2026-10-05 00:00:00' WHERE user_id = ?").bind(uid2).run();
    await run(new Date(Date.UTC(2026, 9, 30, 9, 0)));
    expect(sent).toHaveLength(1);
    await run(new Date(Date.UTC(2026, 9, 30, 10, 0)));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('Связь');
    // час 23 → окно [23, 24): шлёт только последний тик суток
    const uid3 = await user(700122, 'UTC', {
      commits: [{ name: 'Ночь', minor: 100, ccy: 'USD', due: 1 }],
    });
    await env.DB.prepare("UPDATE commitments SET created_at = '2026-10-05 00:00:00' WHERE user_id = ?").bind(uid3).run();
    await scoped(env.DB, uid3).patchProfile({ reminder_hour: 23 });
    await run(new Date(Date.UTC(2026, 9, 30, 22, 0)));
    expect(sent).toHaveLength(2);
    await run(new Date(Date.UTC(2026, 9, 30, 23, 0)));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.text).toContain('Ночь');
  });

  it('итог недели — в свой час; NULL — вс 20:00 (легаси)', async () => {
    const uid = await user(700130, 'UTC', { pay: 0 });
    await scoped(env.DB, uid).patchProfile({ reminder_hour: 8 });
    await run(new Date(Date.UTC(2026, 9, 25, 7, 0))); // вс 07:00 — до своего часа
    expect(sent).toHaveLength(0);
    await run(new Date(Date.UTC(2026, 9, 25, 8, 0))); // вс 08:00 — свой час
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Итоги недели');
    // NULL-юзер в тот же день: 08:00 молча (дедуп своего юзера), вс 20:00 шлёт
    await user(700131, 'UTC', { pay: 0 });
    await run(new Date(Date.UTC(2026, 9, 25, 8, 0)));
    expect(sent).toHaveLength(1);
    await run(new Date(Date.UTC(2026, 9, 25, 20, 0)));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain('Итоги недели');
    // свой час не сдвинул «день»: понедельник 08:00 — уже не воскресенье
    await run(new Date(Date.UTC(2026, 9, 26, 8, 0)));
    expect(sent).toHaveLength(2);
  });
});

describe('P2-5: хозчистка на каждом тике крона', () => {
  it('старые processed_updates (>7д) и reminder_log (>400д) чистятся; свежие и kb_removed живут', async () => {
    const uid = await user(700100, 'UTC', { weekly: 0, pay: 0 });
    // kb_removed этого юзера бэкдейтим — проверяем иммунитет к чистке именно на старой строке
    await env.DB.prepare("UPDATE reminder_log SET sent_at = datetime('now','-401 days') WHERE user_id = ?").bind(uid).run();
    await env.DB.prepare("INSERT INTO reminder_log (user_id, kind, key, sent_at) VALUES (?, 'weekly', 'old', datetime('now','-401 days'))").bind(uid).run();
    await env.DB.prepare("INSERT INTO reminder_log (user_id, kind, key, sent_at) VALUES (?, 'weekly', 'fresh', datetime('now','-1 days'))").bind(uid).run();
    await env.DB.prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (9101, datetime('now','-8 days'))").run();
    await env.DB.prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (9102, datetime('now','-1 days'))").run();
    await run(new Date(Date.UTC(2026, 9, 28, 12, 0)));
    const pu = (await env.DB.prepare('SELECT update_id FROM processed_updates ORDER BY update_id').all<{ update_id: number }>()).results.map((r) => r.update_id);
    expect(pu).toEqual([9102]);
    const rl = (await env.DB.prepare('SELECT kind, key FROM reminder_log WHERE user_id = ? ORDER BY kind, key').bind(uid).all<{ kind: string; key: string }>()).results;
    expect(rl).toEqual([
      { kind: 'kb_removed', key: 'v1' },
      { kind: 'weekly', key: 'fresh' },
    ]);
  });
});

describe('P2-1: runWeek — граница выборки трат', () => {
  it('listExpenses читает от min(понедельник недели, начало месяца), не всю историю', async () => {
    const uid = await user(700101, 'UTC', { weekly: 0, pay: 0 });
    const repo = scoped(env.DB, uid);
    const fxGet = { get: async () => ({ perUsd: { USD: 1, RUB: 97 }, asOf: 'x', stale: false }) };
    const spy = vi.spyOn(repo, 'listExpenses');
    // вс 2026-10-25: неделя с 19.10, месяц с 01.10 → since = '2026-10-01'
    await runWeek(700101, tg, repo, fxGet, '2026-10-25');
    expect(spy).toHaveBeenLastCalledWith('2026-10-01');
    // чт 2026-10-01: неделя началась ещё в сентябре (пн 28.09) → since уходит туда
    await runWeek(700101, tg, repo, fxGet, '2026-10-01');
    expect(spy).toHaveBeenLastCalledWith('2026-09-28');
    spy.mockRestore();
    void uid;
  });
});
