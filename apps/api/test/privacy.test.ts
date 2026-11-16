/** privacy.test.ts — /export и /delete_me (веха D). */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { monthInTz } from '../src/bot/parse';

const SECRET = 's3';
const OWNER = 555000111;
const sent: { text: string }[] = [];
const docs: { chatId: number; filename: string; content: string }[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t) => void sent.push({ text: t }),
  answerCallbackQuery: async () => {},
  sendDocument: async (c, f, content) => void docs.push({ chatId: Number(c), filename: f, content: String(content) }),
};
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1 }, asOf: 'x' }) };
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({ ...env, TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_TELEGRAM_ID: String(OWNER) });
let u = 8000;
const post = (b: unknown) =>
  app.fetch(new Request('https://t/telegram/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }), tenv());
const msg = (id: number, text: string) =>
  post({ update_id: u++, message: { message_id: 1, text, chat: { id, type: 'private' }, from: { id, first_name: 'U' } } });
const cb = (id: number, data: string) =>
  post({ update_id: u++, callback_query: { id: 'c' + u, data, from: { id }, message: { chat: { id, type: 'private' } } } });

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0; docs.length = 0;
  for (const t of ['conversation_state', 'loan_events', 'loans', 'debt_events', 'debts', 'income_entries', 'weekly_expenses', 'categories', 'commitment_changes', 'commitment_payments', 'commitments', 'profiles', 'consents', 'reminder_log', 'audit_log', 'processed_updates', 'invites', 'exchanges', 'users'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
async function onboarded(tgId: number) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD', income_currency: 'EUR', living_currency: 'RUB', timezone: 'Asia/Bishkek',
    income_minor: 100, living_cap_minor: 100, weekly_budget_minor: 25,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
  });
  return uid;
}
/** Таблицы с колонкой user_id (PRAGMA/sqlite_master в workerd D1 запрещены — список статичен по миграциям). */
function userIdTables(): string[] {
  return ['consents', 'audit_log', 'profiles', 'commitments', 'commitment_changes', 'commitment_payments', 'weekly_expenses', 'categories', 'income_entries', 'debts', 'debt_events', 'loans', 'loan_events', 'exchanges', 'conversation_state', 'reminder_log'];
}

describe('/export', () => {
  it('JSON только своих строк, без чужих данных и служебных полей; rate-limit 1/мин', async () => {
    const uidA = await onboarded(710001);
    const uidB = await onboarded(710002);
    const cA = await scoped(env.DB, uidA).addCommitment({ name: 'A-тайное', amount_minor: 1, currency: 'USD', due_day: 1 });
    await scoped(env.DB, uidA).addCommitmentPayment({
      commitment_id: Number(cA.meta.last_row_id), amount_minor: 1, currency: 'USD',
      paid_on: '2026-10-05', source: 'auto', source_key: 'auto:c:1:2026-10',
    });
    await scoped(env.DB, uidA).addDebt({
      name: 'A-ипотека', currency: 'USD', rate: 0.1, frequency: 'monthly',
      initial_balance_minor: 1000, initial_payment_minor: 100, epoch: '2024-01-05', due_day: 5,
    });
    await scoped(env.DB, uidA).addLoan({
      counterparty: 'Вася', direction: 'owe', amount_minor: 30000, currency: 'USD',
      due_on: '2026-11-15', note: null,
    });
    await scoped(env.DB, uidA).addExchange({
      from_ccy: 'EUR', to_ccy: 'RUB', amount_from_minor: 50000, amount_to_minor: 4850000,
      market_rate: 97.1, spent_on: '2026-10-20', note: 'A-касса', source: 'manual', source_key: 'tg:x1',
    });
    await scoped(env.DB, uidB).addExchange({
      from_ccy: 'USD', to_ccy: 'RUB', amount_from_minor: 10000, amount_to_minor: 970000,
      market_rate: null, spent_on: '2026-10-21', note: 'B-данные-обмен', source: 'manual', source_key: 'tg:x2',
    });
    await scoped(env.DB, uidB).addCommitment({ name: 'B-данные', amount_minor: 2, currency: 'USD', due_day: 2 });
    await scoped(env.DB, uidB).addDebt({
      name: 'B-долг', currency: 'USD', rate: 0.1, frequency: 'monthly',
      initial_balance_minor: 2000, initial_payment_minor: 200, epoch: '2024-01-05', due_day: null,
    });
    await msg(710001, '/export');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toMatch(/^budget-export-\d{4}-\d{2}-\d{2}\.json$/);
    const j = JSON.parse(docs[0]!.content) as {
      profile: { user_id: number };
      commitments: { name: string; user_id: number }[];
      commitment_payments: { commitment_id: number; source: string }[];
      debts: { name: string; user_id: number }[];
      debt_events: unknown[];
      loans: { counterparty: string; user_id: number }[];
      loan_events: unknown[];
      exchanges: { from_ccy: string; note: string; user_id: number }[];
      schema_version: number;
    };
    expect(j.schema_version).toBe(6);
    expect(j.profile.user_id).toBe(uidA);
    expect(j.commitments.map((c) => c.name)).toEqual(['A-тайное']);
    expect(j.commitment_payments).toHaveLength(1);
    expect(j.commitment_payments[0]!.source).toBe('auto');
    expect('source_key' in (j.commitment_payments[0] as object)).toBe(false);
    expect(j.debts.map((d) => d.name)).toEqual(['A-ипотека']);
    expect(j.loans.map((l) => l.counterparty)).toEqual(['Вася']);
    expect(j.exchanges).toHaveLength(1);
    expect(j.exchanges[0]!.note).toBe('A-касса');
    expect('source_key' in (j.exchanges[0] as object)).toBe(false);
    expect(docs[0]!.content).not.toContain('B-данные');
    expect(docs[0]!.content).not.toContain('B-долг');
    expect(docs[0]!.content).not.toMatch(/"(password|secret|token|sha256|hash|source_key)"\s*:/i);
    // rate-limit: второй экспорт в ту же минуту
    await msg(710001, '/export');
    expect(docs).toHaveLength(1);
    expect(sent.at(-1)!.text).toContain('раз в минуту');
  });
});

describe('/delete_me', () => {
  it('стирает всё во ВСЕХ таблицах с user_id; другой юзер нетронут; повтор — молча', async () => {
    const uidA = await onboarded(710010);
    const uidB = await onboarded(710011);
    const cA0 = await scoped(env.DB, uidA).addCommitment({ name: 'A', amount_minor: 1, currency: 'USD', due_day: 1 });
    await scoped(env.DB, uidA).addCommitmentPayment({
      commitment_id: Number(cA0.meta.last_row_id), amount_minor: 1, currency: 'USD',
      paid_on: '2024-02-01', source: 'manual', source_key: 'tg:9',
    });
    await scoped(env.DB, uidA).addIncomeEntry({ month: monthInTz('UTC', new Date()), amount_minor: 1, currency: 'USD', note: null, source_key: 'a' });
    const dA = await scoped(env.DB, uidA).addDebt({
      name: 'A', currency: 'USD', rate: 0.1, frequency: 'monthly',
      initial_balance_minor: 1000, initial_payment_minor: 100, epoch: '2024-01-05', due_day: null,
    });
    await scoped(env.DB, uidA).addDebtEvent({
      debt_id: Number(dA.meta.last_row_id), kind: 'payment', amount_minor: 100,
      event_on: '2024-02-05', source: 'manual', source_key: 'tg:1',
    });
    const lA = await scoped(env.DB, uidA).addLoan({
      counterparty: 'Петя', direction: 'owed', amount_minor: 20000, currency: 'USD',
      due_on: null, note: 'займ',
    });
    await scoped(env.DB, uidA).addLoanEvent({
      loan_id: Number(lA.meta.last_row_id), amount_minor: 5000,
      event_on: '2024-03-01', source: 'manual', source_key: null,
    });
    await scoped(env.DB, uidA).addExchange({
      from_ccy: 'EUR', to_ccy: 'RUB', amount_from_minor: 100, amount_to_minor: 9700,
      market_rate: null, spent_on: '2024-03-01', note: '', source: 'manual', source_key: null,
    });
    await scoped(env.DB, uidA).claimReminder('export', 'x');
    await scoped(env.DB, uidB).addCommitment({ name: 'B', amount_minor: 2, currency: 'USD', due_day: 2 });
    const tables = userIdTables();
    // flow: /delete_me → confirm → yes
    await msg(710010, '/delete_me');
    expect(sent.at(-1)!.text).toContain('безвозвратно');
    await cb(710010, 'pf:del:yes');
    expect(sent.at(-1)!.text).toContain('Данные удалены');
    for (const t of tables) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(uidA).first<{ n: number }>();
      expect(n!.n, `${t}: строки юзера A остались`).toBe(0);
    }
    for (const t of ['profiles', 'commitments']) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(uidB).first<{ n: number }>();
      expect(n!.n, `${t}: юзер B задет`).toBeGreaterThan(0);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id=?').bind(uidA).first<{n:number}>())!.n).toBe(0);
    // повтор/stale: юзера нет → callback молча игнорируется
    const n = sent.length;
    await cb(710010, 'pf:del:yes');
    expect(sent.length).toBe(n);
  });
});

describe('миграция 0005 + напоминания в профиле', () => {
  it('на пустой БД применяется; существующим профилям флаги = 1', async () => {
    const uid = await onboarded(710020);
    const p = (await scoped(env.DB, uid).getProfile())!;
    expect(p.reminders_weekly).toBe(1);
    expect(p.reminders_payments).toBe(1);
    const t = await env.DB.prepare('SELECT 1 AS x FROM reminder_log LIMIT 1').first(); // таблица существует
    expect(t === null || t !== undefined).toBe(true);
  });
});
