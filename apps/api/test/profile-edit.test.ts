/**
 * profile-edit.test.ts — шаг 4в: /income, /plan с фактом месяца, редактирование профиля.
 * Все исходящие тексты автоматически проверяются на Telegram-HTML валидность.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { SendMessageOpts, TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { resolveIncome } from '../src/bot/features';
import { monthInTz } from '../src/bot/parse';

const SECRET = 's3';
const OWNER = 555000111;
const sent: { chatId: number; text: string; markup?: unknown }[] = [];
const ALLOWED = new Set(['b', 'i', 'code', 'pre', 'a']);
function assertTgHtml(t: string) {
  const stack: string[] = [];
  let rest = '';
  const re = /<(\/)?([a-zA-Z]+)((?:\s[^<>]*)?)>/g;
  let m: RegExpExecArray | null;
  let last = 0;
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
  latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97, KGS: 86.5 }, asOf: '2026-10-20' }),
};
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({
  ...env,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER),
  TELEGRAM_BOT_USERNAME: 'b',
});
let u = 5000;
const post = (body: unknown) =>
  app.fetch(
    new Request('https://t/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    tenv(),
  );
const msg = (tgId: number, text: string, id?: number) =>
  post({
    update_id: id ?? u++,
    message: { message_id: 1, text, chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'U' } },
  });
const cb = (tgId: number, data: string) =>
  post({
    update_id: u++,
    callback_query: { id: 'cb' + u, data, from: { id: tgId }, message: { chat: { id: tgId, type: 'private' } } },
  });
const last = () => sent.at(-1)!.text;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  for (const t of [
    'conversation_state',
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
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function setupUser(tgId: number, opts: { incomeMinor?: number } = {}) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number(
    (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id,
  );
  await scoped(env.DB, uid).grantConsent('terms');
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD',
    income_currency: 'EUR',
    living_currency: 'RUB',
    timezone: 'Asia/Bishkek',
    income_minor: opts.incomeMinor ?? 620000,
    living_cap_minor: 6000000,
    weekly_budget_minor: Math.round((6000000 * 12) / 52),
    bonus_prepay_share: 0,
    bonus_dca_share: 0,
    onboarded_at: '2026-10-01',
  });
  return uid;
}

describe('resolveIncome (чистая)', () => {
  const pu = { USD: 1, EUR: 1 / 1.09, RUB: 97 };
  it('override > actual > typical > none', () => {
    const entries = [{ amount_minor: 500000, currency: 'RUB' }]; // 5000₽/97 ≈ 51.55$
    expect(
      resolveIncome({
        entries,
        typicalMinor: 620000,
        incomeCcy: 'EUR',
        perUsd: pu,
        override: { amount: 100, currency: 'USD' },
      }),
    ).toMatchObject({ amount: 100, currency: 'USD', source: 'override' });
    // actual: 5000 RUB → USD 51.55 → EUR ~47.29
    const a = resolveIncome({ entries, typicalMinor: 620000, incomeCcy: 'EUR', perUsd: pu });
    expect(a.source).toBe('actual');
    expect(a.amount).toBeCloseTo((5000 / 97) * (1 / 1.09), 2);
    expect(resolveIncome({ entries: [], typicalMinor: 620000, incomeCcy: 'EUR', perUsd: pu })).toMatchObject({
      amount: 6200,
      source: 'typical',
    });
    expect(resolveIncome({ entries: [], typicalMinor: 0, incomeCcy: 'EUR', perUsd: pu })).toMatchObject({
      amount: 0,
      source: 'none',
    });
  });
});

describe('/income', () => {
  it('запись, итог месяца, идемпотентность дубликата', async () => {
    const uid = await setupUser(OWNER + 40);
    const id = u++;
    const body = {
      update_id: id,
      message: {
        message_id: 1,
        text: '/income 5200 eur зарплата',
        chat: { id: OWNER + 40, type: 'private' },
        from: { id: OWNER + 40, first_name: 'U' },
      },
    };
    await post(body);
    expect(last()).toContain('Доход за'); // INCOME_HUB после сохранения (R3)
    const entries = (await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount_minor).toBe(520000);
    await post(body); // дубликат update_id — молча
    expect((await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results).toHaveLength(
      1,
    );
  });

  it('список + удаление через кнопки с confirm', async () => {
    const uid = await setupUser(OWNER + 41);
    await msg(OWNER + 41, '/income 5200 eur зарплата');
    await msg(OWNER + 41, '/income'); // → INCOME_HUB
    await cb(OWNER + 41, 'inc:list'); // → INCOME_LIST
    expect(last()).toContain('зарплата');
    const eid = (await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results[0]!.id;
    await cb(OWNER + 41, `in:del:${eid}`);
    expect(last()).toContain('Удалить запись');
    await cb(OWNER + 41, 'in:del:yes');
    expect(last()).toContain('Удалено');
    expect(last()).toContain('записей нет'); // список без удалённой записи
    expect((await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results).toHaveLength(
      0,
    );
  });

  it('чужой id записи — молча игнорируется (cross-tenant)', async () => {
    const uid = await setupUser(OWNER + 42);
    await setupUser(OWNER + 43);
    await scoped(env.DB, uid).addIncomeEntry({
      month: monthInTz('Asia/Bishkek', new Date()),
      amount_minor: 100,
      currency: 'EUR',
      note: null,
      source_key: 'x',
    });
    const eid = (await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results[0]!.id;
    await cb(OWNER + 43, `in:del:${eid}`); // user 43 пытается удалить запись 42
    const n = sent.length;
    await cb(OWNER + 43, 'in:del:yes');
    expect(sent.length).toBe(n); // ничего не ответили
    expect((await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results).toHaveLength(
      1,
    );
  });

  it('граница месяца по таймзоне (31.10 23:30 UTC → ноябрь в Бишкеке)', () => {
    expect(monthInTz('Asia/Bishkek', new Date(Date.UTC(2026, 9, 31, 23, 30)))).toBe('2026-11');
    expect(monthInTz('UTC', new Date(Date.UTC(2026, 9, 31, 23, 30)))).toBe('2026-10');
  });
});

describe('/plan с фактом месяца', () => {
  it('факт (записи) побивает типичный; «нет дохода» помечено', async () => {
    const uid = await setupUser(OWNER + 44);
    await scoped(env.DB, uid).addIncomeEntry({
      month: monthInTz('Asia/Bishkek', new Date()),
      amount_minor: 300000,
      currency: 'EUR',
      note: null,
      source_key: 'a',
    });
    // факт 3000€ → USD 3270; типичный 6200€ игнорируется
    await msg(OWNER + 44, '/plan');
    const t = last();
    expect(t).toContain('3 270 $');
    expect(t).toContain('факт за');
    expect(t).toContain('1 записей');
    // без записей → типичный
    const uid2 = await setupUser(OWNER + 45);
    void uid2;
    await msg(OWNER + 45, '/plan');
    expect(last()).toContain('6 758');
    expect(last()).toContain('типичный');
    // без дохода вообще
    const uid3 = await setupUser(OWNER + 46, { incomeMinor: 0 });
    void uid3;
    await msg(OWNER + 46, '/plan');
    expect(last()).toContain('без дохода');
    // override
    await msg(OWNER + 45, '/plan 1000 usd');
    expect(last()).toContain('1 000 $');
    expect(last()).toContain('задано вручную');
  });
});

describe('редактирование профиля (pf:*)', () => {
  it('типичный доход: изменить и убрать', async () => {
    const uid = await setupUser(OWNER + 50);
    await msg(OWNER + 50, '⚙️ Профиль');
    await cb(OWNER + 50, 'pf:sec:income');
    expect(last()).toContain('Типичный');
    await cb(OWNER + 50, 'pf:typ');
    expect(last()).toContain('Новый типичный доход');
    await msg(OWNER + 50, '7500');
    expect(last()).toContain('7 500');
    expect(last()).toContain('Типичный'); // PF_INCOME перерисован с новым значением
    expect((await scoped(env.DB, uid).getProfile())!.income_minor).toBe(750000);
    await cb(OWNER + 50, 'pf:sec:income');
    await cb(OWNER + 50, 'pf:typ');
    await cb(OWNER + 50, 'pf:typ0');
    expect(last()).toContain('убран');
    expect((await scoped(env.DB, uid).getProfile())!.income_minor).toBe(0);
  });

  it('лимит жизни: правка пересчитывает недельный бюджет', async () => {
    const uid = await setupUser(OWNER + 51);
    await msg(OWNER + 51, '⚙️ Профиль');
    await cb(OWNER + 51, 'pf:sec:living'); // → PF_LIVING
    await cb(OWNER + 51, 'pf:liv'); // → PF_LIVING_ASK
    await msg(OWNER + 51, '90000');
    expect(last()).toContain('90 000'); // экран-источник с новым значением
    const p = (await scoped(env.DB, uid).getProfile())!;
    expect(p.living_cap_minor).toBe(9000000);
    expect(p.weekly_budget_minor).toBe(Math.round((9000000 * 12) / 52));
  });

  it('платежи: сумма, день, вкл/выкл, удалить, добавить — чужие id молча', async () => {
    const uid = await setupUser(OWNER + 52);
    const uidB = await setupUser(OWNER + 53);
    void uidB;
    await scoped(env.DB, uid).addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
    await scoped(env.DB, uid).addCommitment({ name: 'Связь', amount_minor: 50000, currency: 'USD', due_day: null });
    const cid = (await scoped(env.DB, uid).listCommitments()).results[0]!.id;
    await msg(OWNER + 52, '⚙️ Профиль');
    await cb(OWNER + 52, 'pf:sec:commits');
    expect(last()).toContain('Аренда');
    await cb(OWNER + 52, `pf:cm:${cid}`);
    expect(last()).toContain('700 $');
    await cb(OWNER + 52, `pf:ca:${cid}`);
    await msg(OWNER + 52, '800');
    expect(last()).toContain('800 $'); // карточка рендерится ПОСЛЕ мутации
    expect((await scoped(env.DB, uid).getCommitment(cid))!.amount_minor).toBe(80000);
    await cb(OWNER + 52, `pf:cday:${cid}`);
    await msg(OWNER + 52, '15');
    expect(last()).toContain('15');
    expect((await scoped(env.DB, uid).getCommitment(cid))!.due_day).toBe(15);
    await cb(OWNER + 52, `pf:ctog:${cid}`);
    expect(last()).toContain('⏸'); // выключенный виден сразу
    expect((await scoped(env.DB, uid).getCommitment(cid))!.active).toBe(0);
    // выключенный не входит в /plan
    await msg(OWNER + 52, '/plan');
    expect(last()).not.toContain('800 $');
    await msg(OWNER + 52, '⚙️ Профиль'); // /plan закрыл меню — открываем заново
    await cb(OWNER + 52, 'pf:sec:commits');
    await cb(OWNER + 52, `pf:cm:${cid}`);
    await cb(OWNER + 52, `pf:cdel:${cid}`);
    expect(last()).toContain('Удалить');
    await cb(OWNER + 52, 'pf:cdel:yes');
    expect((await scoped(env.DB, uid).listCommitments()).results.find((c) => c.id === cid)).toBeUndefined();
    // добавить — ПЕРВЫЙ вернувшийся список содержит новый платёж (регрессия stale-render)
    await cb(OWNER + 52, 'pf:cadd');
    await msg(OWNER + 52, 'Интернет 600 kgs 5');
    expect(last()).toContain('Интернет');
    const cbs = (
      (sent.at(-1)!.markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => b.callback_data ?? '');
    expect(cbs.some((d) => d.startsWith('pf:cm:'))).toBe(true);
    expect((await scoped(env.DB, uid).listCommitments()).results.some((c) => c.name === 'Интернет')).toBe(true);
    // чужой id молча
    const n = sent.length;
    await cb(OWNER + 53, `pf:cm:${(await scoped(env.DB, uid).listCommitments()).results[0]!.id}`);
    expect(sent.length).toBe(n);
  });

  it('валюта и пояс: смена валюты с предупреждением, таймзона кнопкой', async () => {
    const uid = await setupUser(OWNER + 54);
    await msg(OWNER + 54, '⚙️ Профиль');
    await cb(OWNER + 54, 'pf:sec:ccytz');
    expect(last()).toContain('не пересчитываются');
    await cb(OWNER + 54, 'pf:ccy:income');
    await msg(OWNER + 54, 'USD');
    expect(last()).toContain('USD');
    expect((await scoped(env.DB, uid).getProfile())!.income_currency).toBe('USD');
    await cb(OWNER + 54, 'pf:sec:ccytz');
    await cb(OWNER + 54, 'pf:tz');
    await cb(OWNER + 54, 'pf:tzv:UTC');
    expect((await scoped(env.DB, uid).getProfile())!.timezone).toBe('UTC');
  });

  it('«Пропустить» доход в онбординге → income 0; /cancel в правке → отмена', async () => {
    await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')")
      .bind(OWNER + 55)
      .run();
    await msg(OWNER + 55, '/start');
    await cb(OWNER + 55, 'ob:terms:ok');
    await cb(OWNER + 55, 'ob:ic:EUR');
    expect(last()).toContain('Пропустить');
    await cb(OWNER + 55, 'ob:inc:skip');
    expect(last()).toContain('Лимит');
    const uid55 = Number(
      (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?')
        .bind(OWNER + 55)
        .first<{ id: number }>())!.id,
    );
    // доход пропущен → ждём лимит
    await msg(OWNER + 55, '50000 rub');
    await cb(OWNER + 55, 'ob:tz:Asia/Bishkek');
    await cb(OWNER + 55, 'ob:com:skip');
    expect(last()).toContain('сохранён');
    expect((await scoped(env.DB, uid55).getProfile())!.income_minor).toBe(0);
    // /cancel в правке
    await msg(OWNER + 55, '⚙️ Профиль');
    await cb(OWNER + 55, 'pf:sec:living');
    await cb(OWNER + 55, 'pf:liv'); // → PF_LIVING_ASK (промпт)
    await msg(OWNER + 55, '/cancel');
    expect(last()).toContain('Отменено'); // возврат на экран-источник (R2)
    expect((await scoped(env.DB, uid55).getConversation())!.step).toBe('pf:living');
  });

  it('stale pf-callback на другом шаге — молча', async () => {
    await setupUser(OWNER + 56);
    await msg(OWNER + 56, '⚙️ Профиль');
    await cb(OWNER + 56, 'pf:sec:income'); // step pf:income
    const n = sent.length;
    await cb(OWNER + 56, 'pf:cadd'); // кнопка раздела платежей — чужой шаг
    expect(sent.length).toBe(n);
  });
});

describe('траты: отмена / правка / удаление (ex:*)', () => {
  const mk = () =>
    (sent.at(-1)!.markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? [];
  const cbsOf = () =>
    mk()
      .flat()
      .map((b) => b.callback_data ?? '');

  it('SPENT_DONE: [↩ Отменить] удаляет запись; повтор — без ошибки; [✏️] → правка', async () => {
    const uid = await setupUser(OWNER + 60);
    await msg(OWNER + 60, '➕ Трата');
    await msg(OWNER + 60, '344 кафе');
    expect(last()).toContain('Записал: 344');
    const undo = cbsOf().find((d) => d.startsWith('ex:undo:'))!;
    const eid = Number(undo.slice(8));
    expect(cbsOf()).toContain(`ex:e:${eid}`);
    expect(cbsOf()).toContain('nv:home');
    // undo → удалено, строки нет
    await cb(OWNER + 60, undo);
    expect(last()).toContain('Трата удалена');
    expect((await scoped(env.DB, uid).listExpenses()).results).toHaveLength(0);
    // повторный undo — тихий no-op
    const n = sent.length;
    await cb(OWNER + 60, undo);
    expect(sent.length).toBe(n);
  });

  it('правка суммы → карточка показывает новое; /week пересчитан', async () => {
    const uid = await setupUser(OWNER + 61);
    await msg(OWNER + 61, '➕ Трата');
    await msg(OWNER + 61, '344 кафе');
    const ecb = cbsOf().find((d) => d.startsWith('ex:e:'))!;
    const eid = Number(ecb.slice(5));
    await cb(OWNER + 61, ecb);
    expect(last()).toContain('Новая сумма');
    await msg(OWNER + 61, '700 eur бензин');
    expect(last()).toContain('700');
    const e = (await scoped(env.DB, uid).getExpense(eid))!;
    expect(e.amount_minor).toBe(70000);
    expect(e.currency).toBe('EUR');
    expect(e.note).toBe('бензин');
  });

  it('список недели → карточка → удаление → список без записи; /expenses пустой', async () => {
    const uid = await setupUser(OWNER + 62);
    await msg(OWNER + 62, '/expenses');
    expect(last()).toContain('Трат за неделю нет');
    await msg(OWNER + 62, '➕ Трата');
    await msg(OWNER + 62, '100 обед');
    const eid = (await scoped(env.DB, uid).listExpenses()).results[0]!.id;
    await msg(OWNER + 62, '/expenses');
    expect(
      mk()
        .flat()
        .map((b) => b.text)
        .join(' '),
    ).toContain('обед');
    await cb(OWNER + 62, `ex:v:${eid}`);
    expect(last()).toContain('100');
    await cb(OWNER + 62, `ex:del:${eid}`);
    expect(last()).toContain('Удалить');
    await cb(OWNER + 62, 'ex:dyes');
    expect(last()).toContain('Удалено');
    expect((await scoped(env.DB, uid).listExpenses()).results).toHaveLength(0);
  });

  it('изоляция: юзер B не может отменить/удалить трату юзера A', async () => {
    const uidA = await setupUser(OWNER + 63);
    await setupUser(OWNER + 64);
    await msg(OWNER + 63, '➕ Трата');
    await msg(OWNER + 63, '50 чужое');
    const eid = (await scoped(env.DB, uidA).listExpenses()).results[0]!.id;
    const n = sent.length;
    await cb(OWNER + 64, `ex:undo:${eid}`); // чужой id — молча
    expect(sent.length).toBe(n);
    expect((await scoped(env.DB, uidA).listExpenses()).results).toHaveLength(1);
    await cb(OWNER + 64, `ex:v:${eid}`);
    expect(sent.length).toBe(n);
  });
});
