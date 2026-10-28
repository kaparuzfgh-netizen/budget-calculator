/**
 * step4.test.ts — онбординг, команды бюджета, FX, изоляция (workerd + локальная D1).
 * Фейковые TelegramClient и FxProvider — всё офлайн.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { TelegramClient, SendMessageOpts } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { advance, startOnboarding } from '../src/bot/onboarding';
import { parseAmount, parseCommitmentLine, todayInTz } from '../src/bot/parse';
import { fmtMoney } from '../src/bot/format';
import { getFxRates } from '../src/fx/service';
import { scoped } from '../src/db/repo';

const SECRET = 's3';
const OWNER = 555000111;
const sent: { chatId: number; text: string; markup?: unknown }[] = [];
const cbAcked: string[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t, o?: SendMessageOpts) => {
    sent.push({ chatId: Number(c), text: t, markup: o?.replyMarkup });
  },
  answerCallbackQuery: async (id) => {
    cbAcked.push(id);
  },
  sendDocument: async () => {},
};
const fx: FxProvider = {
  latest: async (ccys) => ({
    perUsd: {
      USD: 1,
      EUR: 1 / 1.09,
      RUB: 97,
      KGS: 86.5,
      ...Object.fromEntries(ccys.map((c) => [c, c === 'EUR' ? 1 / 1.09 : 97])),
    },
    asOf: '2026-10-20',
  }),
};
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({
  ...env,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER),
  TELEGRAM_BOT_USERNAME: 'b',
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
    message: {
      message_id: u,
      text,
      chat: { id: tgId, type: 'private' },
      from: { id: tgId, first_name: 'U' + (tgId % 100) },
    },
  });
const cb = (tgId: number, data: string) =>
  post({
    update_id: u++,
    callback_query: {
      id: 'cb' + u,
      data,
      from: { id: tgId, first_name: 'U' },
      message: { chat: { id: tgId, type: 'private' } },
    },
  });
const last = () => sent.at(-1)!.text;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  // порядок важен: дочерние таблицы (FK → users) — до users
  for (const t of [
    'conversation_state',
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
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe('онбординг (happy path через webhook)', () => {
  it('владелец проходит все шаги → профиль + меню', async () => {
    await msg(OWNER, 'привет'); // bootstrap owner
    await msg(OWNER, '/start');
    expect(last()).toContain('Согласны');
    await cb(OWNER, 'ob:terms:ok');
    expect(last()).toContain('валюте основной доход');
    await cb(OWNER, 'ob:ic:EUR');
    expect(last()).toContain('месячный доход');
    await msg(OWNER, '6200');
    expect(last()).toContain('Лимит «на жизнь»');
    await msg(OWNER, '60000 rub');
    expect(last()).toContain('часовой пояс');
    await cb(OWNER, 'ob:tz:Asia/Bishkek');
    expect(last()).toContain('Обязательные платежи');
    await msg(OWNER, 'Аренда 700 usd 1');
    expect(last()).toContain('Аренда');
    await msg(OWNER, 'Комуналка 30000 rub');
    await cb(OWNER, 'ob:com:done');
    expect(last()).toContain('Профиль сохранён');
    const p = await scoped(env.DB, 1).getProfile();
    expect(p?.income_currency).toBe('EUR');
    expect(p?.income_minor).toBe(620000);
    expect(p?.living_cap_minor).toBe(6000000);
    expect(p?.weekly_budget_minor).toBe(Math.round((6000000 * 12) / 52));
    expect(p?.timezone).toBe('Asia/Bishkek');
    expect(p?.onboarded_at).toBeTruthy();
    const commits = (await scoped(env.DB, 1).listCommitments()).results;
    expect(commits).toHaveLength(2);
    expect(commits[0]!.due_day).toBe(1);
  });

  it('невалидный ввод → ошибка, шаг сохраняется; /cancel работает', async () => {
    await msg(OWNER, 'x');
    await msg(OWNER, '/start');
    await cb(OWNER, 'ob:terms:ok');
    await cb(OWNER, 'ob:ic:USD');
    await msg(OWNER, 'abc');
    expect(last()).toContain('Не понял сумму');
    await msg(OWNER, '-5');
    expect(last()).toContain('положительным');
    await msg(OWNER, '/cancel');
    expect(last()).toContain('отменена');
    const conv = await scoped(env.DB, 1).getConversation();
    expect(conv).toBeFalsy();
  });

  it('другая валюта через FX-валидацию', async () => {
    await msg(OWNER, 'x');
    await msg(OWNER, '/start');
    await cb(OWNER, 'ob:terms:ok');
    await cb(OWNER, 'ob:ic:X');
    await msg(OWNER, 'RUB'); // поддерживается fake-провайдером
    expect(last()).toContain('месячный доход');
  });

  it('/id от незнакомца когда owner задан → тишина', async () => {
    await msg(999888777, '/id');
    expect(sent).toEqual([]);
  });
});

describe('команды бюджета', () => {
  async function setupUser(tgId: number) {
    await env.DB.prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, 'U', 'member')")
      .bind(tgId)
      .run();
    const uid = Number(
      (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id,
    );
    await scoped(env.DB, uid).grantConsent('terms');
    await scoped(env.DB, uid).upsertProfile({
      base_currency: 'USD',
      income_currency: 'EUR',
      living_currency: 'RUB',
      timezone: 'Asia/Bishkek',
      income_minor: 620000,
      living_cap_minor: 6000000,
      weekly_budget_minor: Math.round((6000000 * 12) / 52),
      bonus_prepay_share: 0,
      bonus_dca_share: 0,
      onboarded_at: '2026-10-01',
    });
    return uid;
  }

  it('/plan: числа против ручного расчёта (6200 EUR @1.09 → 6758 USD)', async () => {
    const uid = await setupUser(OWNER + 1);
    await scoped(env.DB, uid).addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
    await scoped(env.DB, uid).addCommitment({ name: 'Связь', amount_minor: 3000000, currency: 'RUB', due_day: null });
    // ожидание: income=6758 USD; mandatory=700+30000/97≈1009.28; living=60000/97≈618.56; surplus≈5030.17
    await msg(OWNER + 1, '/plan');
    const t = last();
    expect(t).toContain('6 758');
    expect(t).toContain('1 009,28 $'); // 700$ + 30000₽/97 ≈ 1009,28$
    expect(t).toContain('Свободный профицит');
  });

  it('/spent: запись, идемпотентность дубликата, статус недели', async () => {
    const uid = await setupUser(OWNER + 2);
    const body = (u2: number) => ({
      update_id: u2,
      message: {
        message_id: u2,
        text: '/spent 3200 kgs кофе',
        chat: { id: OWNER + 2, type: 'private' },
        from: { id: OWNER + 2, first_name: 'U' },
      },
    });
    const uid0 = u++;
    await post(body(uid0));
    expect(last()).toContain('Записал');
    const exp = (await scoped(env.DB, uid).listExpenses()).results;
    expect(exp).toHaveLength(1);
    expect(exp[0]!.amount_minor).toBe(320000);
    expect(exp[0]!.currency).toBe('KGS');
    // дубликат update_id — вторая запись не создаётся (и апдейт дедупится роутером)
    await post(body(uid0));
    expect((await scoped(env.DB, uid).listExpenses()).results).toHaveLength(1);
    // нереальная сумма отклоняется
    await msg(OWNER + 2, '/spent 999999999 rub');
    expect(last()).toContain('нереально');
  });

  it('/week без трат → «нет данных»', async () => {
    await setupUser(OWNER + 3);
    await msg(OWNER + 3, '📅 Неделя');
    expect(last()).toContain('нет трат');
  });

  it('/profile открывает меню разделов', async () => {
    await setupUser(OWNER + 4);
    await msg(OWNER + 4, '⚙️ Профиль');
    expect(last()).toContain('Профиль');
    await cb(OWNER + 4, 'pf:sec:ccytz');
    expect(last()).toContain('Валюта и пояс');
  });

  it('callback от незнакомца — молча, но answerCallbackQuery уходит', async () => {
    cbAcked.length = 0;
    await cb(999000999, 'ob:terms:ok');
    expect(cbAcked).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});

describe('изоляция tenant (S5)', () => {
  it('A не видит профиль/платежи/траты B', async () => {
    await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member'), (?, 'member')").bind(1, 2).run();
    const a = scoped(env.DB, 1);
    const b = scoped(env.DB, 2);
    await a.upsertProfile({
      base_currency: 'USD',
      income_currency: 'EUR',
      living_currency: 'RUB',
      timezone: 'UTC',
      income_minor: 1,
      living_cap_minor: 2,
      weekly_budget_minor: 0,
      bonus_prepay_share: 0,
      bonus_dca_share: 0,
      onboarded_at: 'x',
    });
    await a.addCommitment({ name: 'secret', amount_minor: 5, currency: 'USD', due_day: null });
    await a.addExpense({
      spent_on: '2026-10-20',
      amount_minor: 7,
      currency: 'USD',
      note: null,
      source: 'manual',
      source_key: 'k1',
    });
    await a.setConversation('step', '{}');
    expect(await b.getProfile()).toBeFalsy();
    expect((await b.listCommitments()).results).toEqual([]);
    expect((await b.listExpenses()).results).toEqual([]);
    expect(await b.getConversation()).toBeFalsy();
  });
});

describe('редьюсер и парсеры (юниты)', () => {
  it('advance: terms→income_ccy; commitments накапливаются; done→persist', () => {
    const r0 = startOnboarding();
    expect(r0.state.step).toBe('terms');
    let st = advance(r0.state, { type: 'callback', data: 'ob:terms:ok' });
    expect(st.state!.step).toBe('income_ccy');
    st = advance(st.state!, { type: 'callback', data: 'ob:ic:EUR' });
    expect(st.state!.step).toBe('income_amount');
    st = advance(st.state!, { type: 'text', text: '6200' });
    st = advance(st.state!, { type: 'text', text: '60000 rub' });
    st = advance(st.state!, { type: 'callback', data: 'ob:tz:Asia/Bishkek' });
    st = advance(st.state!, { type: 'text', text: 'Аренда 700 usd 1' });
    st = advance(st.state!, { type: 'text', text: 'Связь 500' });
    st = advance(st.state!, { type: 'callback', data: 'ob:com:done' });
    expect(st.state).toBeNull();
    expect(st.effects.some((e) => e.kind === 'persist')).toBe(true);
  });

  it('parseAmount: «1 234,50», «3200 kgs кофе», мусор', () => {
    expect(parseAmount('1 234,50')).toMatchObject({ amount: 1234.5 });
    expect(parseAmount('3200 kgs кофе')).toMatchObject({ amount: 3200, currency: 'KGS', note: 'кофе' });
    expect(() => parseAmount('abc')).toThrow();
    expect(() => parseAmount('-5')).toThrow();
    expect(() => parseAmount('1e10')).toThrow();
  });

  it('parseAmount: разговорные валюты — «500 руб», «500р», «2000 сом», «700€», «300 баксов»', () => {
    expect(parseAmount('500 руб')).toMatchObject({ amount: 500, currency: 'RUB' });
    expect(parseAmount('500р')).toMatchObject({ amount: 500, currency: 'RUB' });
    expect(parseAmount('500 рублей')).toMatchObject({ amount: 500, currency: 'RUB' });
    expect(parseAmount('500 р.')).toMatchObject({ amount: 500, currency: 'RUB' });
    expect(parseAmount('2000 сом')).toMatchObject({ amount: 2000, currency: 'KGS' });
    expect(parseAmount('2 000 сомов')).toMatchObject({ amount: 2000, currency: 'KGS' });
    expect(parseAmount('300 баксов')).toMatchObject({ amount: 300, currency: 'USD' });
    expect(parseAmount('700€')).toMatchObject({ amount: 700, currency: 'EUR' });
    expect(parseAmount('50 000 тенге')).toMatchObject({ amount: 50000, currency: 'KZT' });
    expect(parseAmount('900 грн')).toMatchObject({ amount: 900, currency: 'UAH' });
    // не валюта — уходит в заметку, как раньше
    expect(parseAmount('320 кофе')).toMatchObject({ amount: 320, note: 'кофе' });
    expect(parseAmount('320 кофе')).not.toMatchObject({ currency: expect.anything() });
    expect(parseAmount('500 с гарантией')).toMatchObject({ amount: 500, note: 'с гарантией' });
    expect(parseAmount('500 сом за телефон')).toMatchObject({ amount: 500, currency: 'KGS', note: 'за телефон' });
  });

  it('parseCommitmentLine / fmtMoney / tz', () => {
    expect(parseCommitmentLine('Аренда 700 usd 1')).toMatchObject({
      name: 'Аренда',
      amount: 700,
      currency: 'USD',
      dueDay: 1,
    });
    expect(parseCommitmentLine('Связь 500')).toMatchObject({ name: 'Связь', amount: 500 });
    expect(fmtMoney(44282, 'RUB')).toBe('44 282 ₽');
    expect(fmtMoney(1234.5, 'USD')).toBe('1 234,50 $');
    // граница таймзоны: 23:30 UTC = следующий день в Бишкеке (+6)
    expect(todayInTz('Asia/Bishkek', new Date(Date.UTC(2026, 9, 20, 23, 30)))).toBe('2026-10-21');
    expect(todayInTz('UTC', new Date(Date.UTC(2026, 9, 20, 23, 30)))).toBe('2026-10-20');
  });
});

describe('FX-сервис', () => {
  it('кэш-hit, stale-fallback, полный отказ → FxUnavailable', async () => {
    const good: FxProvider = { latest: async () => ({ perUsd: { EUR: 0.9 }, asOf: '2026-10-20' }) };
    const now = new Date('2026-10-20T12:00:00Z');
    let r = await getFxRates(env.DB, good, ['EUR'], now);
    expect(r.perUsd['EUR']).toBe(0.9);
    expect(r.stale).toBe(false);
    // провайдер умер — свежий кэш (<6ч) всё равно отдаётся
    const bad: FxProvider = {
      latest: async () => {
        throw new Error('down');
      },
    };
    r = await getFxRates(env.DB, bad, ['EUR'], new Date('2026-10-20T13:00:00Z'));
    expect(r.perUsd['EUR']).toBe(0.9);
    expect(r.stale).toBe(false);
    // кэш старше 6ч → stale:true
    r = await getFxRates(env.DB, bad, ['EUR'], new Date('2026-10-21T00:00:00Z'));
    expect(r.stale).toBe(true);
    // валюта без кэша и провайдер мёртв → исключение
    await expect(getFxRates(env.DB, bad, ['GBP'], new Date('2026-10-21T00:00:00Z'))).rejects.toThrow(
      'Курсы временно недоступны',
    );
  });
});
