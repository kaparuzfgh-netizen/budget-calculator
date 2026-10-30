/**
 * nav.test.ts — контракт навигации: каждый экран реестра проезжается реальными
 * нажатиями кнопок через webhook; проверяются нав-ряды (R1–R4), цели переходов
 * (R2/R3/R5/R7), что HOME достижим, и что экраны не шлют незарегистрированные
 * callback_data. Плюс doc-sync: mermaid-схема == реестр.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { getScreen, navRow, REGISTRY } from '../src/bot/nav/nav';
import { scoped } from '../src/db/repo';
import { monthInTz } from '../src/bot/parse';
// @ts-expect-error — vite ?raw import
import navDocRaw from '../../../docs/ux/navigation.md?raw';

// ── doc-sync: mermaid-рёбра == реестр ──
const md = navDocRaw as string;
const mer = md.match(/```mermaid([\s\S]*?)```/)?.[1] ?? '';
const merEdges = new Set<string>();
for (const line of mer.split('\n')) {
  const m = /^\s*([A-Z_]+)\s+.*?>+\s*([A-Z_]+)/.exec(line);
  if (m) merEdges.add(`${m[1]}->${m[2]}`);
}
const regEdges = new Set(REGISTRY.edges.map(([a, b]) => `${a}->${b}`));

describe('реестр vs mermaid', () => {
  it('рёбра и узлы совпадают с docs/ux/navigation.md', () => {
    for (const e of regEdges) expect(merEdges.has(e), `в схеме нет ребра ${e}`).toBe(true);
    const merNodes = new Set([...mer.matchAll(/([A-Z_]{2,})\[/g)].map((m) => m[1]));
    for (const s of REGISTRY.screens) expect(merNodes.has(s.id), `в схеме нет узла ${s.id}`).toBe(true);
  });
});

// ── e2e харнесс ──
const SECRET = 's3';
const OWNER = 555000111;
interface Btn {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}
const sent: { text: string; markup?: { inline_keyboard?: Btn[][] } }[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t, o) => {
    sent.push({ text: t, markup: o?.replyMarkup as never });
  },
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
};
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97 }, asOf: '2026-10-20' }) };
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({
  ...env,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER),
});
let u = 9000;
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
    callback_query: { id: 'c' + u, data, from: { id: tgId }, message: { chat: { id: tgId, type: 'private' } } },
  });
const lastMsg = () => sent.at(-1)!;
// web_app-кнопки (📱 Приложение) callback_data не имеют — исключаем из проверок
const lastCbs = () =>
  (lastMsg().markup?.inline_keyboard ?? [])
    .flat()
    .map((b) => b.callback_data)
    .filter((d): d is string => !!d);
const navCbs = () => lastCbs().filter((d) => d.startsWith('nv:'));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  for (const t of [
    'conversation_state',
    'debt_events',
    'debts',
    'loan_events',
    'loans',
    'exchanges',
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
async function onboarded(tgId: number, withCommit = true) {
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
  if (withCommit)
    await scoped(env.DB, uid).addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
  return uid;
}
/** whitelist: зарегистрированные пространства callback_data */
const CB_OK =
  /^(nv:(home|back:[A-Z_]+|go:[A-Z_]+)|pf:[a-z0-9:/_-]*|in:del:\d+$|in:del:(yes|no)$|inc:(add|list)$|ex:[a-z]+:\d+(:\d+)?$|ex:(list|dyes)$|rp:(week|month|quarter|half|year):-?\d+$|dbt:[a-z0-9:]+|ln:[a-z0-9:]+|fxa:[a-z0-9:]+|vs:[a-z0-9:]+|ob:[a-z:]+)/i;
function assertNavRow(expected: string[], actualLast: string[], screen: string) {
  expect(actualLast, `${screen}: нав-ряд ${JSON.stringify(actualLast)}`).toEqual(expected);
}
const expectNav = (screenId: string, backTo?: string) => {
  const row = navRow(screenId, backTo);
  const cbs = lastCbs();
  captured[screenId] = cbs;
  for (const d of cbs) expect(CB_OK.test(d), `${screenId}: незарегистрированный callback ${d}`).toBe(true);
  if (row) {
    const lastRow: string[] = (lastMsg().markup?.inline_keyboard ?? []).at(-1)?.map((b) => b.callback_data ?? '') ?? [];
    assertNavRow(
      row.map((b) => b.callback_data!),
      lastRow,
      screenId,
    );
  } else {
    expect(navCbs(), `${screenId}: не должно быть nv-кнопок`).toEqual([]);
  }
};
/** Захваченные разметки экранов для проверки «ребро → кнопка». */
const captured: Record<string, string[]> = {};
/** Куда ведёт [🏠] и [←] на экране: определяем экран по содержимому ответа. */
function screenOf(): string {
  const cbs = lastCbs();
  const t = lastMsg().text;
  if (t === 'Главное меню') return 'HOME';
  if (cbs.includes('pf:sec:income')) return 'PF_HOME';
  if (cbs.includes('pf:typ')) return 'PF_INCOME';
  if (cbs.includes('pf:liv')) return 'PF_LIVING';
  if (cbs.some((d) => d.startsWith('pf:cm:'))) return 'PF_COMMITS';
  if (cbs.some((d) => d.startsWith('pf:ca:'))) return 'PF_COMMIT';
  if (cbs.includes('pf:cdel:yes')) return 'PF_COMMIT_DEL';
  if (t.includes('Удалить оплату')) return 'PF_CPAY_DEL';
  if (t.includes('Оплата «') && t.includes('Новая сумма')) return 'PF_CPAY_EDIT';
  if (t.includes('Оплата «')) return 'PF_CPAY';
  if (cbs.includes('pf:ccy:income')) return 'PF_LOCALE';
  if (cbs.includes('pf:rem:weekly')) return 'PF_REMINDERS';
  if (cbs.includes('pf:exp:go')) return 'PF_DATA';
  if (cbs.includes('pf:del:yes')) return 'PF_DELETE_ASK';
  if (cbs.includes('dbt:del:yes')) return 'DEBT_DEL';
  if (cbs.some((d) => /^dbt:del:\d+$/.test(d))) return 'DEBT';
  if (cbs.includes('dbt:add')) return 'DEBTS';
  if (cbs.some((d) => d.startsWith('dbt:pp:go:'))) return 'DEBT_PREPAY';
  if (t.includes('ЧДП по')) return 'DEBT_PREPAY_ASK';
  if (t.includes('Платёж по')) return 'DEBT_PAY';
  if (t.includes('выписке банка')) return 'DEBT_RECON';
  if (t.includes('Сверить «')) return 'VIS_RECON';
  if (cbs.includes('dbt:ed:rate')) return 'DEBT_EDIT';
  if (t.includes('Новая ставка')) return 'DEBT_EDIT_RATE';
  if (t.includes('Новый платёж за период')) return 'DEBT_EDIT_PAYMENT';
  if (t.includes('Новый день платежа')) return 'DEBT_EDIT_DUE';
  if (t.includes('Удалить событие')) return 'DEBT_EVENT_DEL';
  if (/(Новая|Новый)/.test(t) && /Платёж|ЧДП|Сверка/.test(t)) return 'DEBT_EVENT_EDIT';
  if (t.includes('Событие «')) return 'DEBT_EVENT';
  if (t.includes('Событие — сумма') || t.includes('Пока без событий')) return 'DEBT_HIST';
  if (t.includes('Удалить возврат')) return 'LOAN_EVENT_DEL';
  if (t.includes('Новая сумма') && t.includes('Возврат')) return 'LOAN_EVENT_EDIT';
  if (t.includes('— 💸 Возврат')) return 'LOAN_EVENT';
  if (t.includes('Возврат — сумма') || t.includes('Пока без возвратов')) return 'LOAN_HIST';
  if (t.includes('Новый кредит — название')) return 'DEBT_ADD_NAME';
  if (t.includes('Остаток кредита')) return 'DEBT_ADD_BALANCE';
  if (t.includes('Ставка, % годовых')) return 'DEBT_ADD_RATE';
  if (t.includes('Платёж за период')) return 'DEBT_ADD_PAYMENT';
  if (t.includes('Как часто платёж')) return 'DEBT_ADD_FREQ';
  if (t.includes('День платежа в месяце')) return 'DEBT_ADD_DUE';
  if (t.includes('Дата ближайшего платежа')) return 'DEBT_ADD_EPOCH';
  if (cbs.includes('ln:cl:yes')) return 'LOAN_CLOSE';
  if (cbs.includes('ln:dl:yes')) return 'LOAN_DEL';
  if (t.includes('Сумма (')) return 'LOAN_REPAY';
  if (t.includes('Новый срок возврата')) return 'LOAN_DUE_EDIT';
  if (cbs.some((d) => d === 'ln:rp' || d === 'ln:cl' || d === 'ln:dl')) return 'LOAN';
  if (t.includes('Закрытые займы')) return 'LOANS_CLOSED';
  if (cbs.includes('ln:add')) return 'LOANS';
  if (t.includes('кто кому должен')) return 'LOAN_ADD_DIR';
  if (t.includes('Кто должен') || t.includes('Кому должен')) return 'LOAN_ADD_NAME';
  if (t.includes('Сумма и валюта')) return 'LOAN_ADD_AMOUNT';
  if (t.includes('Срок возврата')) return 'LOAN_ADD_DUE';
  if (t.includes('Заметка (или')) return 'LOAN_ADD_NOTE';
  if (cbs.includes('fxa:dyes')) return 'FX_DEL';
  if (cbs.includes('fxa:ed:amounts')) return 'FX_ITEM';
  if (t.includes('Новые суммы —')) return 'FX_EDIT_AMOUNTS';
  if (t.includes('Новая дата —')) return 'FX_EDIT_DATE';
  if (t.includes('Новая заметка')) return 'FX_EDIT_NOTE';
  if (t.includes('Из чего меняем')) return 'FX_ADD_FROM';
  if (t.includes('Во что меняем')) return 'FX_ADD_TO';
  if (t.includes('Суммы обмена —')) return 'FX_ADD_AMOUNTS';
  if (t.includes('Дата обмена —')) return 'FX_ADD_DATE';
  if (t.includes('Заметка к обмену')) return 'FX_ADD_NOTE';
  if (t.includes('Журнал обменов')) return 'FX_LIST';
  if (cbs.includes('fxa:list')) return 'FX_HUB';
  if (cbs.includes('ex:dyes')) return 'EXPENSE_DEL';
  if (t.includes('формат как при вводе')) return 'EXPENSE_EDIT_ASK';
  if (cbs.some((d) => d.startsWith('ex:e:'))) return 'EXPENSE';
  if (cbs.some((d) => d.startsWith('ex:v:')) || t.includes('Траты недели') || t.includes('Трат за неделю нет'))
    return 'EXPENSES_LIST';
  if (cbs.includes('inc:add')) return 'INCOME_HUB';
  if (cbs.some((d) => /^in:del:\d+$/.test(d))) return 'INCOME_LIST';
  if (cbs.includes('in:del:yes')) return 'INCOME_DEL';
  if (t.includes('План месяца')) return 'PLAN';
  if (t.includes('Неделя') || t.includes('недел')) return 'WEEK';
  if (t.includes('Сколько потратили')) return 'SPENT_ASK';
  if (t.includes('Сколько получили')) return 'INCOME_ASK';
  if (t.includes('Новый типичный')) return 'PF_TYPICAL_ASK';
  if (t.includes('норма повседневных')) return 'PF_LIVING_ASK';
  if (t.includes('Новый платёж')) return 'PF_COMMIT_ADD';
  if (t.includes('Новая сумма')) return 'PF_COMMIT_AMOUNT';
  if (t.includes('День месяца')) return 'PF_COMMIT_DAY';
  if (t.includes('Часовой пояс') || t.includes('валюты')) return 'PF_LOCALE_PICK';
  return 'UNKNOWN';
}

describe('контракт навигации (walk)', () => {
  it('каждый экран: нав-ряд по реестру, переходы по кнопкам ведут куда надо', async () => {
    const tgId = OWNER + 70;
    const uid = await onboarded(tgId);
    const cid = (await scoped(env.DB, uid).listCommitments()).results[0]!.id;
    const month = monthInTz('Asia/Bishkek', new Date());
    await scoped(env.DB, uid).addIncomeEntry({
      month,
      amount_minor: 520000,
      currency: 'EUR',
      note: 'зарплата',
      source_key: 'k1',
    });

    // HOME
    await msg(tgId, '/menu');
    expect(screenOf()).toBe('HOME');
    expect(lastCbs()).toContain('nv:go:PLAN');
    // запуск Mini App — только через menu-button у поля ввода (setChatMenuButton),
    // inline-кнопки «📱 Приложение» на HOME нет
    expect((lastMsg().markup?.inline_keyboard ?? []).flat().some((b) => b.web_app)).toBe(false);

    // PLAN (result): [🏠]
    await cb(tgId, 'nv:go:PLAN');
    expect(screenOf()).toBe('PLAN');
    expectNav('PLAN');
    await cb(tgId, 'nv:home');
    expect(screenOf()).toBe('HOME');

    // WEEK (result): [🏠]
    await msg(tgId, '📅 Неделя');
    expect(screenOf()).toBe('WEEK');
    expectNav('WEEK');

    // SPENT_ASK prompt: [✖]→HOME; save → SPENT_DONE [🏠]
    await msg(tgId, '➕ Трата');
    expect(screenOf()).toBe('SPENT_ASK');
    expectNav('SPENT_ASK');
    await msg(tgId, '320');
    expectNav('SPENT_DONE');

    // INCOME_HUB: [🏠] (из HOME); [➕][📋]
    await cb(tgId, 'nv:home');
    await cb(tgId, 'nv:go:INCOME_HUB');
    expect(screenOf()).toBe('INCOME_HUB');
    expectNav('INCOME_HUB');
    // INCOME_ASK: [✖]→INCOME_HUB
    await cb(tgId, 'inc:add');
    expect(screenOf()).toBe('INCOME_ASK');
    expectNav('INCOME_ASK');
    await cb(tgId, 'nv:back:INCOME_HUB');
    expect(screenOf()).toBe('INCOME_HUB');
    // INCOME_LIST: [←][🏠] back→INCOME_HUB
    await cb(tgId, 'inc:list');
    expect(screenOf()).toBe('INCOME_LIST');
    expectNav('INCOME_LIST');
    // INCOME_DEL: [Да][✖] → cancel→INCOME_LIST
    const eid = (await scoped(env.DB, uid).listIncomeEntries(month)).results[0]!.id;
    await cb(tgId, `in:del:${eid}`);
    expect(screenOf()).toBe('INCOME_DEL');
    expectNav('INCOME_DEL');
    await cb(tgId, 'in:del:no');
    expect(screenOf()).toBe('INCOME_LIST');
    // сохранение дохода → INCOME_HUB (R3)
    await cb(tgId, 'nv:back:INCOME_HUB');
    await cb(tgId, 'inc:add');
    await msg(tgId, '5200 eur бонус');
    expect(screenOf()).toBe('INCOME_HUB');

    // PF_HOME: [←][🏠] → HOME
    await msg(tgId, '⚙️ Профиль');
    expect(screenOf()).toBe('PF_HOME');
    expectNav('PF_HOME');
    // PF_INCOME: [← PF_HOME][🏠]
    await cb(tgId, 'pf:sec:income');
    expect(screenOf()).toBe('PF_INCOME');
    expectNav('PF_INCOME');
    await cb(tgId, 'nv:back:PF_HOME');
    expect(screenOf()).toBe('PF_HOME');
    // PF_TYPICAL_ASK: [✖]→PF_INCOME; save → PF_INCOME
    await cb(tgId, 'pf:sec:income');
    await cb(tgId, 'pf:typ');
    expect(screenOf()).toBe('PF_TYPICAL_ASK');
    expectNav('PF_TYPICAL_ASK');
    await msg(tgId, '7500');
    expect(screenOf()).toBe('PF_INCOME');
    expectNav('PF_INCOME');
    // «Факт по месяцам» → INCOME_HUB с back→PF_INCOME (altParent)
    await cb(tgId, 'pf:inc:hub');
    expect(screenOf()).toBe('INCOME_HUB');
    expectNav('INCOME_HUB', 'PF_INCOME');
    await cb(tgId, 'nv:back:PF_INCOME');
    expect(screenOf()).toBe('PF_INCOME');

    // PF_LIVING / PF_LIVING_ASK
    await cb(tgId, 'nv:back:PF_HOME');
    await cb(tgId, 'pf:sec:living');
    expect(screenOf()).toBe('PF_LIVING');
    expectNav('PF_LIVING');
    await cb(tgId, 'pf:liv');
    expect(screenOf()).toBe('PF_LIVING_ASK');
    expectNav('PF_LIVING_ASK');
    await cb(tgId, 'nv:back:PF_LIVING');
    expect(screenOf()).toBe('PF_LIVING');

    // PF_COMMITS / PF_COMMIT / промпты / confirm
    await cb(tgId, 'nv:back:PF_HOME');
    await cb(tgId, 'pf:sec:commits');
    expect(screenOf()).toBe('PF_COMMITS');
    expectNav('PF_COMMITS');
    await cb(tgId, `pf:cm:${cid}`);
    expect(screenOf()).toBe('PF_COMMIT');
    expectNav('PF_COMMIT');
    await cb(tgId, `pf:ca:${cid}`);
    expect(screenOf()).toBe('PF_COMMIT_AMOUNT');
    expectNav('PF_COMMIT_AMOUNT');
    await cb(tgId, 'nv:back:PF_COMMIT');
    expect(screenOf()).toBe('PF_COMMIT');
    await cb(tgId, `pf:cday:${cid}`);
    expectNav('PF_COMMIT_DAY');
    await cb(tgId, 'nv:back:PF_COMMIT');
    expect(screenOf()).toBe('PF_COMMIT');
    await cb(tgId, `pf:cdel:${cid}`);
    expect(screenOf()).toBe('PF_COMMIT_DEL');
    expectNav('PF_COMMIT_DEL');
    await cb(tgId, 'pf:cdel:no');
    expect(screenOf()).toBe('PF_COMMIT');
    // журнал оплат: ✅ Оплачено → карточка оплаты → правка (отмена) → удаление
    await cb(tgId, `pf:cpay:${cid}`);
    expect(screenOf()).toBe('PF_COMMIT');
    expect(lastMsg().text).toContain('оплачен');
    const cpid = (await scoped(env.DB, uid).listCommitmentPayments(cid)).results[0]!.id;
    await cb(tgId, `pf:cp:${cpid}`);
    expect(screenOf()).toBe('PF_CPAY');
    expectNav('PF_CPAY');
    await cb(tgId, `pf:cpe:${cpid}`);
    expect(screenOf()).toBe('PF_CPAY_EDIT');
    expectNav('PF_CPAY_EDIT');
    await cb(tgId, 'nv:back:PF_COMMIT'); // ✖ Отмена → карточка платежа
    expect(screenOf()).toBe('PF_COMMIT');
    await cb(tgId, `pf:cp:${cpid}`);
    await cb(tgId, `pf:cpd:${cpid}`);
    expect(screenOf()).toBe('PF_CPAY_DEL');
    expectNav('PF_CPAY_DEL');
    await cb(tgId, 'pf:cpdy'); // удалено → карточка платежа
    expect(screenOf()).toBe('PF_COMMIT');
    expect(lastMsg().text).toContain('Удалено');
    // снова отметили оплаченным — кнопка «✅ Оплачено» пропадает, появляется запись
    await cb(tgId, `pf:cpay:${cid}`);
    expect(screenOf()).toBe('PF_COMMIT');
    expect(lastCbs()).not.toContain(`pf:cpay:${cid}`);
    // чужой/несуществующий id оплаты — молча на список платежей
    await cb(tgId, 'pf:cp:999999');
    expect(screenOf()).toBe('PF_COMMITS');
    await cb(tgId, `pf:cm:${cid}`);
    expect(screenOf()).toBe('PF_COMMIT');
    // вернуться к оплате и удалить её, чтобы дальнейшие шаги видели исходную карточку
    const cpid2 = (await scoped(env.DB, uid).listCommitmentPayments(cid)).results[0]!.id;
    await cb(tgId, `pf:cp:${cpid2}`);
    await cb(tgId, `pf:cpd:${cpid2}`);
    await cb(tgId, 'pf:cpdy');
    // back из карточки → список
    await cb(tgId, 'nv:back:PF_COMMITS');
    expect(screenOf()).toBe('PF_COMMITS');
    // добавить платёж → после ввода список
    await cb(tgId, 'pf:cadd');
    expect(screenOf()).toBe('PF_COMMIT_ADD');
    expectNav('PF_COMMIT_ADD');
    await msg(tgId, 'Связь 300 usd 3');
    expect(screenOf()).toBe('PF_COMMITS');
    expectNav('PF_COMMITS');

    // PF_LOCALE / pick
    await cb(tgId, 'nv:back:PF_HOME');
    await cb(tgId, 'pf:sec:ccytz');
    expect(screenOf()).toBe('PF_LOCALE');
    expectNav('PF_LOCALE');
    await cb(tgId, 'pf:ccy:income');
    expectNav('PF_LOCALE_PICK');
    await cb(tgId, 'nv:back:PF_LOCALE');
    expect(screenOf()).toBe('PF_LOCALE');

    // PF_REMINDERS / PF_DATA / PF_DELETE_ASK
    await cb(tgId, 'nv:back:PF_HOME');
    await cb(tgId, 'pf:sec:reminders');
    expect(screenOf()).toBe('PF_REMINDERS');
    expectNav('PF_REMINDERS');
    await cb(tgId, 'pf:rem:weekly'); // toggle — свежий рендер
    expect(screenOf()).toBe('PF_REMINDERS');
    await cb(tgId, 'nv:back:PF_HOME');
    await cb(tgId, 'pf:sec:data');
    expect(screenOf()).toBe('PF_DATA');
    expectNav('PF_DATA');
    await cb(tgId, 'pf:del:ask');
    expect(screenOf()).toBe('PF_DELETE_ASK');
    expectNav('PF_DELETE_ASK');
    await cb(tgId, 'nv:back:PF_DATA');
    expect(screenOf()).toBe('PF_DATA');
    await cb(tgId, 'nv:back:PF_HOME');

    // траты: SPENT_DONE → EXPENSE_EDIT_ASK / EXPENSE*; WEEK → EXPENSES_LIST
    await msg(tgId, '➕ Трата');
    await msg(tgId, '320 кофе');
    captured.SPENT_DONE = lastCbs();
    const und = lastCbs().find((d) => d.startsWith('ex:undo:'))!;
    const xid = Number(und.slice(8));
    await cb(tgId, 'nv:back:WEEK');
    expect(screenOf()).toBe('WEEK');
    captured.WEEK = lastCbs();
    await cb(tgId, 'ex:list');
    expect(screenOf()).toBe('EXPENSES_LIST');
    expectNav('EXPENSES_LIST');
    await cb(tgId, `ex:v:${xid}`);
    expect(screenOf()).toBe('EXPENSE');
    expectNav('EXPENSE');
    await cb(tgId, `ex:e:${xid}`);
    expect(screenOf()).toBe('EXPENSE_EDIT_ASK');
    expectNav('EXPENSE_EDIT_ASK');
    await cb(tgId, 'nv:back:EXPENSE');
    expect(screenOf()).toBe('EXPENSE');
    await cb(tgId, `ex:del:${xid}`);
    expect(screenOf()).toBe('EXPENSE_DEL');
    expectNav('EXPENSE_DEL');
    await cb(tgId, 'nv:back:EXPENSE');
    expect(screenOf()).toBe('EXPENSE');

    // ── кредиты: DEBTS → мастер → DEBT → DEBT_DEL ──
    await msg(tgId, '/credits');
    expect(screenOf()).toBe('DEBTS');
    expectNav('DEBTS');
    // мастер (monthly): все промпты с [✖]→DEBTS, финиш → список
    await cb(tgId, 'dbt:add');
    expect(screenOf()).toBe('DEBT_ADD_NAME');
    expectNav('DEBT_ADD_NAME');
    await msg(tgId, 'Ипотека Сбер');
    expect(screenOf()).toBe('DEBT_ADD_BALANCE');
    expectNav('DEBT_ADD_BALANCE');
    await msg(tgId, '2100000 rub');
    expect(screenOf()).toBe('DEBT_ADD_RATE');
    expectNav('DEBT_ADD_RATE');
    await msg(tgId, '11.9');
    expect(screenOf()).toBe('DEBT_ADD_PAYMENT');
    expectNav('DEBT_ADD_PAYMENT');
    await msg(tgId, '21500');
    expect(screenOf()).toBe('DEBT_ADD_FREQ');
    expectNav('DEBT_ADD_FREQ');
    await cb(tgId, 'dbt:af:m');
    expect(screenOf()).toBe('DEBT_ADD_DUE');
    expectNav('DEBT_ADD_DUE');
    await msg(tgId, '15');
    expect(screenOf()).toBe('DEBTS'); // сохранено → исходный экран (R3)
    expectNav('DEBTS');
    const did = (await scoped(env.DB, uid).listDebts()).results[0]!.id;
    // карточка DEBT: [← DEBTS][🏠]; операции H2: платёж/ЧДП/сверка/правки/история
    await cb(tgId, `dbt:v:${did}`);
    expect(screenOf()).toBe('DEBT');
    expectNav('DEBT');
    // платёж: промпт [✖]→DEBT; кнопка «по графику» → записан → карточка
    await cb(tgId, 'dbt:pay');
    expect(screenOf()).toBe('DEBT_PAY');
    expectNav('DEBT_PAY');
    await cb(tgId, 'dbt:pay:sched');
    expect(screenOf()).toBe('DEBT');
    // ЧДП: сумма → превью (confirm) → запись → карточка
    await cb(tgId, 'dbt:pp');
    expect(screenOf()).toBe('DEBT_PREPAY_ASK');
    expectNav('DEBT_PREPAY_ASK');
    await msg(tgId, '100000');
    expect(screenOf()).toBe('DEBT_PREPAY');
    expectNav('DEBT_PREPAY');
    await cb(tgId, 'dbt:pp:go:p'); // выбор режима «платёж↓»
    expect(screenOf()).toBe('DEBT');
    // сверка с банком: промпт → карточка
    await cb(tgId, 'dbt:rc');
    expect(screenOf()).toBe('DEBT_RECON');
    expectNav('DEBT_RECON');
    await msg(tgId, '980000');
    expect(screenOf()).toBe('DEBT');
    // правки: меню → ставка (отмена → меню) → платёж → сохранено → карточка
    await cb(tgId, 'dbt:ed');
    expect(screenOf()).toBe('DEBT_EDIT');
    expectNav('DEBT_EDIT');
    await cb(tgId, 'dbt:ed:rate');
    expect(screenOf()).toBe('DEBT_EDIT_RATE');
    expectNav('DEBT_EDIT_RATE');
    await cb(tgId, 'nv:back:DEBT_EDIT');
    expect(screenOf()).toBe('DEBT_EDIT');
    await cb(tgId, 'dbt:ed:pay');
    expect(screenOf()).toBe('DEBT_EDIT_PAYMENT');
    expectNav('DEBT_EDIT_PAYMENT');
    await msg(tgId, '22000');
    expect(screenOf()).toBe('DEBT');
    await cb(tgId, 'dbt:ed');
    await cb(tgId, 'dbt:ed:day');
    expect(screenOf()).toBe('DEBT_EDIT_DUE');
    expectNav('DEBT_EDIT_DUE');
    await cb(tgId, 'nv:back:DEBT');
    expect(screenOf()).toBe('DEBT');
    // история событий — result [←][🏠] → DEBT; событие → правка/удаление
    await cb(tgId, 'dbt:hist');
    expect(screenOf()).toBe('DEBT_HIST');
    expectNav('DEBT_HIST');
    const evId = (await scoped(env.DB, uid).listDebtEvents(did)).results.at(-1)!.id;
    await cb(tgId, `dbt:ev:${evId}`);
    expect(screenOf()).toBe('DEBT_EVENT');
    expectNav('DEBT_EVENT');
    await cb(tgId, `dbt:ev:e:${evId}`);
    expect(screenOf()).toBe('DEBT_EVENT_EDIT');
    expectNav('DEBT_EVENT_EDIT');
    await cb(tgId, 'nv:back:DEBT_EVENT'); // ✖ Отмена → карточка события
    expect(screenOf()).toBe('DEBT_EVENT');
    await cb(tgId, `dbt:ev:d:${evId}`);
    expect(screenOf()).toBe('DEBT_EVENT_DEL');
    expectNav('DEBT_EVENT_DEL');
    await cb(tgId, `dbt:ev:dy:${evId}`); // удалено → журнал
    expect(screenOf()).toBe('DEBT_HIST');
    await cb(tgId, 'nv:back:DEBT');
    expect(screenOf()).toBe('DEBT');
    await cb(tgId, `dbt:del:${did}`);
    expect(screenOf()).toBe('DEBT_DEL');
    expectNav('DEBT_DEL');
    await cb(tgId, 'nv:back:DEBT'); // Отмена → карточка
    expect(screenOf()).toBe('DEBT');
    // vision-сверка (шаг 7): фото → «какой кредит?» → VIS_RECON → сверено → DEBT
    await scoped(env.DB, uid).setConversation('vs:recon', JSON.stringify({ amount_minor: 98765400 }));
    await cb(tgId, `vs:rec:${did}`);
    expect(screenOf()).toBe('VIS_RECON');
    expectNav('VIS_RECON');
    await cb(tgId, 'nv:back:DEBTS'); // ✖ Отмена → список кредитов
    expect(screenOf()).toBe('DEBTS');
    // снова подтверждение и сверка → reconcile-событие, карточка DEBT
    await scoped(env.DB, uid).setConversation('vs:recon', JSON.stringify({ amount_minor: 98765400 }));
    await cb(tgId, `vs:rec:${did}`);
    await cb(tgId, `vs:reconok:${did}`);
    expect(screenOf()).toBe('DEBT');
    expectNav('DEBT');
    // biweekly-мастер: freq → EPOCH-кнопка «Сегодня»
    await cb(tgId, 'nv:back:DEBTS');
    await cb(tgId, 'dbt:add');
    await msg(tgId, 'Автокредит');
    await msg(tgId, '500000 rub');
    await msg(tgId, '9.5');
    await msg(tgId, '12000');
    await cb(tgId, 'dbt:af:b');
    expect(screenOf()).toBe('DEBT_ADD_EPOCH');
    expectNav('DEBT_ADD_EPOCH');
    await cb(tgId, 'dbt:ae:today');
    expect(screenOf()).toBe('DEBTS');

    // ── долги людям: LOANS → мастер → LOAN → REPAY → CLOSE/DEL ──
    await msg(tgId, '/loans');
    expect(screenOf()).toBe('LOANS');
    expectNav('LOANS');
    await cb(tgId, 'ln:add');
    expect(screenOf()).toBe('LOAN_ADD_DIR');
    expectNav('LOAN_ADD_DIR');
    await cb(tgId, 'ln:dir:owe'); // я должен
    expect(screenOf()).toBe('LOAN_ADD_NAME');
    expectNav('LOAN_ADD_NAME');
    await msg(tgId, 'Вася');
    expect(screenOf()).toBe('LOAN_ADD_AMOUNT');
    expectNav('LOAN_ADD_AMOUNT');
    await msg(tgId, '300 usd');
    expect(screenOf()).toBe('LOAN_ADD_DUE');
    expectNav('LOAN_ADD_DUE');
    await msg(tgId, '15.11');
    expect(screenOf()).toBe('LOAN_ADD_NOTE');
    expectNav('LOAN_ADD_NOTE');
    await cb(tgId, 'ln:nonote');
    expect(screenOf()).toBe('LOANS'); // сохранено → список (R3)
    const lid = (await scoped(env.DB, uid).listLoans()).results[0]!.id;
    // карточка: [💸][✅][🗑] + [← LOANS][🏠]
    await cb(tgId, `ln:v:${lid}`);
    expect(screenOf()).toBe('LOAN');
    expectNav('LOAN');
    // возврат частью → карточка; промпт отмены → карточка
    await cb(tgId, 'ln:rp');
    expect(screenOf()).toBe('LOAN_REPAY');
    expectNav('LOAN_REPAY');
    await msg(tgId, '100');
    expect(screenOf()).toBe('LOAN');
    await cb(tgId, 'ln:rp');
    await cb(tgId, 'nv:back:LOAN'); // ✖ Отмена → карточка
    expect(screenOf()).toBe('LOAN');
    // смена срока: промпт [✖]→LOAN; новая дата → карточка
    await cb(tgId, 'ln:dd');
    expect(screenOf()).toBe('LOAN_DUE_EDIT');
    expectNav('LOAN_DUE_EDIT');
    await msg(tgId, '20.12');
    expect(screenOf()).toBe('LOAN');
    // журнал возвратов: событие → правка (отмена) → удаление → журнал
    const levId = (await scoped(env.DB, uid).listLoanEvents(lid)).results.at(-1)!.id;
    await cb(tgId, 'ln:hs');
    expect(screenOf()).toBe('LOAN_HIST');
    expectNav('LOAN_HIST');
    await cb(tgId, `ln:ev:${levId}`);
    expect(screenOf()).toBe('LOAN_EVENT');
    expectNav('LOAN_EVENT');
    await cb(tgId, `ln:ev:e:${levId}`);
    expect(screenOf()).toBe('LOAN_EVENT_EDIT');
    expectNav('LOAN_EVENT_EDIT');
    await cb(tgId, 'nv:back:LOAN_EVENT'); // ✖ Отмена → карточка события
    expect(screenOf()).toBe('LOAN_EVENT');
    await cb(tgId, `ln:ev:d:${levId}`);
    expect(screenOf()).toBe('LOAN_EVENT_DEL');
    expectNav('LOAN_EVENT_DEL');
    await cb(tgId, `ln:ev:dy:${levId}`); // удалено → журнал
    expect(screenOf()).toBe('LOAN_HIST');
    await cb(tgId, 'nv:back:LOAN');
    expect(screenOf()).toBe('LOAN');
    // закрытие: confirm → карточка (закрыт)
    await cb(tgId, 'ln:cl');
    expect(screenOf()).toBe('LOAN_CLOSE');
    expectNav('LOAN_CLOSE');
    await cb(tgId, 'ln:cl:yes');
    expect(screenOf()).toBe('LOAN');
    // архив: список → «✅ Закрытые» → карточка закрытого займа
    await cb(tgId, 'nv:back:LOANS');
    expect(screenOf()).toBe('LOANS');
    await cb(tgId, 'ln:arc');
    expect(screenOf()).toBe('LOANS_CLOSED');
    expectNav('LOANS_CLOSED');
    await cb(tgId, `ln:v:${lid}`);
    expect(screenOf()).toBe('LOAN');
    // назад → LOANS, возврат в карточку для удаления
    await cb(tgId, 'nv:back:LOANS');
    expect(screenOf()).toBe('LOANS');
    await cb(tgId, `ln:v:${lid}`);
    expect(screenOf()).toBe('LOAN');
    // удаление закрытого: confirm → список
    await cb(tgId, 'ln:dl');
    expect(screenOf()).toBe('LOAN_DEL');
    expectNav('LOAN_DEL');
    await cb(tgId, 'ln:dl:yes');
    expect(screenOf()).toBe('LOANS');
    expectNav('LOANS');

    // ── курсы: FX_HUB → FX_LIST → мастер обмена → FX_ITEM → правки/удаление ──
    await msg(tgId, '/fx');
    expect(screenOf()).toBe('FX_HUB');
    expectNav('FX_HUB');
    await cb(tgId, 'fxa:list');
    expect(screenOf()).toBe('FX_LIST');
    expectNav('FX_LIST');
    // мастер записи: из чего → во что → суммы → дата → заметка → журнал (R3)
    await cb(tgId, 'fxa:add');
    expect(screenOf()).toBe('FX_ADD_FROM');
    expectNav('FX_ADD_FROM');
    await cb(tgId, 'fxa:af:EUR');
    expect(screenOf()).toBe('FX_ADD_TO');
    expectNav('FX_ADD_TO');
    await cb(tgId, 'fxa:at:RUB');
    expect(screenOf()).toBe('FX_ADD_AMOUNTS');
    expectNav('FX_ADD_AMOUNTS');
    await msg(tgId, '500 → 48500');
    expect(screenOf()).toBe('FX_ADD_DATE');
    expectNav('FX_ADD_DATE');
    await cb(tgId, 'fxa:ad:today');
    expect(screenOf()).toBe('FX_ADD_NOTE');
    expectNav('FX_ADD_NOTE');
    await cb(tgId, 'fxa:an:skip');
    expect(screenOf()).toBe('FX_LIST'); // записано → журнал (R3)
    expect(lastMsg().text).toContain('Записано');
    const exid = (await scoped(env.DB, uid).listExchanges()).results[0]!.id;
    // карточка обмена: [← FX_LIST][🏠]; кнопки правок/удаления
    await cb(tgId, `fxa:v:${exid}`);
    expect(screenOf()).toBe('FX_ITEM');
    expectNav('FX_ITEM');
    await cb(tgId, 'fxa:ed:amounts');
    expect(screenOf()).toBe('FX_EDIT_AMOUNTS');
    expectNav('FX_EDIT_AMOUNTS');
    await msg(tgId, '400 → 39000');
    expect(screenOf()).toBe('FX_ITEM'); // сохранено → карточка
    await cb(tgId, 'fxa:ed:date');
    expect(screenOf()).toBe('FX_EDIT_DATE');
    expectNav('FX_EDIT_DATE');
    await cb(tgId, 'fxa:et:today');
    expect(screenOf()).toBe('FX_ITEM');
    await cb(tgId, 'fxa:ed:note');
    expect(screenOf()).toBe('FX_EDIT_NOTE');
    expectNav('FX_EDIT_NOTE');
    await msg(tgId, 'обмен в кассе');
    expect(screenOf()).toBe('FX_ITEM');
    // удаление: confirm → журнал
    await cb(tgId, `fxa:del:${exid}`);
    expect(screenOf()).toBe('FX_DEL');
    expectNav('FX_DEL');
    await cb(tgId, 'fxa:dyes');
    expect(screenOf()).toBe('FX_LIST');

    // HOME из глубины за ≤3 нажатия: с карточки платежа
    await cb(tgId, 'nv:home');
    expect(screenOf()).toBe('HOME');
  }, 60_000); // walk всех экранов длинный — под нагрузкой всего рана >20с

  it('PF_HOME рендерит ровно 6 кнопок разделов (регрессия)', async () => {
    const tgId = OWNER + 40;
    await onboarded(tgId);
    await cb(tgId, 'nv:go:PF_HOME');
    expect(screenOf()).toBe('PF_HOME');
    const secs = lastCbs().filter((d) => d.startsWith('pf:sec:'));
    expect(secs).toEqual([
      'pf:sec:income',
      'pf:sec:living',
      'pf:sec:commits',
      'pf:sec:ccytz',
      'pf:sec:reminders',
      'pf:sec:data',
    ]);
  });

  it('каждое ребро «menu/result → X» имеет кнопку на отрендеренном экране', () => {
    // карта callback → целевой экран (не-нав кнопки экранов)
    const BTN: [RegExp, (m: RegExpMatchArray) => string][] = [
      [
        /^pf:sec:(income|living|commits|ccytz|reminders|data)$/,
        (m) =>
          ({
            income: 'PF_INCOME',
            living: 'PF_LIVING',
            commits: 'PF_COMMITS',
            ccytz: 'PF_LOCALE',
            reminders: 'PF_REMINDERS',
            data: 'PF_DATA',
          })[m[1]!]!,
      ],
      [/^pf:inc:hub$/, () => 'INCOME_HUB'],
      [/^pf:typ$/, () => 'PF_TYPICAL_ASK'],
      [/^pf:liv$/, () => 'PF_LIVING_ASK'],
      [/^pf:cadd$/, () => 'PF_COMMIT_ADD'],
      [/^pf:cm:\d+$/, () => 'PF_COMMIT'],
      [/^pf:ca:\d+$/, () => 'PF_COMMIT_AMOUNT'],
      [/^pf:cday:\d+$/, () => 'PF_COMMIT_DAY'],
      [/^pf:cdel:\d+$/, () => 'PF_COMMIT_DEL'],
      [/^pf:cp:\d+$/, () => 'PF_CPAY'],
      [/^pf:cpe:\d+$/, () => 'PF_CPAY_EDIT'],
      [/^pf:cpd:\d+$/, () => 'PF_CPAY_DEL'],
      [/^pf:ccy:(income|living)$/, () => 'PF_LOCALE_PICK'],
      [/^pf:tz$/, () => 'PF_LOCALE_PICK'],
      [/^pf:del:ask$/, () => 'PF_DELETE_ASK'],
      [/^inc:add$/, () => 'INCOME_ASK'],
      [/^inc:list$/, () => 'INCOME_LIST'],
      [/^in:del:\d+$/, () => 'INCOME_DEL'],
      [/^dbt:v:\d+$/, () => 'DEBT'],
      [/^dbt:add$/, () => 'DEBT_ADD_NAME'],
      [/^dbt:del:\d+$/, () => 'DEBT_DEL'],
      [/^dbt:pay$/, () => 'DEBT_PAY'],
      [/^dbt:pp$/, () => 'DEBT_PREPAY_ASK'],
      [/^dbt:rc$/, () => 'DEBT_RECON'],
      [/^dbt:ed$/, () => 'DEBT_EDIT'],
      [/^dbt:ed:rate$/, () => 'DEBT_EDIT_RATE'],
      [/^dbt:ed:pay$/, () => 'DEBT_EDIT_PAYMENT'],
      [/^dbt:ed:day$/, () => 'DEBT_EDIT_DUE'],
      [/^dbt:hist$/, () => 'DEBT_HIST'],
      [/^dbt:ev:\d+$/, () => 'DEBT_EVENT'],
      [/^dbt:ev:e:\d+$/, () => 'DEBT_EVENT_EDIT'],
      [/^dbt:ev:d:\d+$/, () => 'DEBT_EVENT_DEL'],
      [/^ln:v:\d+$/, () => 'LOAN'],
      [/^ln:add$/, () => 'LOAN_ADD_DIR'],
      [/^ln:rp$/, () => 'LOAN_REPAY'],
      [/^ln:dd$/, () => 'LOAN_DUE_EDIT'],
      [/^ln:cl$/, () => 'LOAN_CLOSE'],
      [/^ln:dl$/, () => 'LOAN_DEL'],
      [/^ln:hs$/, () => 'LOAN_HIST'],
      [/^ln:ev:\d+$/, () => 'LOAN_EVENT'],
      [/^ln:ev:e:\d+$/, () => 'LOAN_EVENT_EDIT'],
      [/^ln:ev:d:\d+$/, () => 'LOAN_EVENT_DEL'],
      [/^ex:list$/, () => 'EXPENSES_LIST'],
      [/^ex:v:\d+$/, () => 'EXPENSE'],
      [/^ex:e:\d+$/, () => 'EXPENSE_EDIT_ASK'],
      [/^ex:del:\d+$/, () => 'EXPENSE_DEL'],
      [/^fxa:list$/, () => 'FX_LIST'],
      [/^fxa:add$/, () => 'FX_ADD_FROM'],
      [/^fxa:v:\d+$/, () => 'FX_ITEM'],
      [/^fxa:ed:amounts$/, () => 'FX_EDIT_AMOUNTS'],
      [/^fxa:ed:date$/, () => 'FX_EDIT_DATE'],
      [/^fxa:ed:note$/, () => 'FX_EDIT_NOTE'],
      [/^fxa:del:\d+$/, () => 'FX_DEL'],
    ];
    // для каждого посещённого экрана проверяем, что каждая «button»-цель покрыта кнопкой
    const NAV = (to: string) => [`nv:back:${to}`, 'nv:home'];
    for (const [screenId, cbs] of Object.entries(captured)) {
      const scr = getScreen(screenId);
      if (!scr || !['menu', 'result'].includes(scr.kind)) continue;
      const targets = new Set(REGISTRY.edges.filter(([f]) => f === screenId).map(([, t]) => t));
      for (const to of targets) {
        if (NAV(to).some((n) => cbs.includes(n))) continue; // навигационное ребро покрыто нав-рядом
        const ok = cbs.some((c) => BTN.some(([re, fn]) => re.test(c) && fn(c.match(re)!) === to));
        expect(ok, `${screenId} → ${to}: нет кнопки в разметке (${cbs.join(',')})`).toBe(true);
      }
    }
  });

  it('домой ≤3 нажатий от любого экрана (реестр)', () => {
    for (const s of REGISTRY.screens) {
      let hops = 0;
      let cur = s;
      while (cur.id !== 'HOME' && hops < 10) {
        cur = getScreen(cur.parent ?? cur.altParent ?? '')!;
        hops++;
      }
      expect(cur.id, `${s.id}`).toBe('HOME');
      expect(hops).toBeLessThanOrEqual(4);
    }
  });

  it('stale/чужие кнопки молча игнорируются (R7)', async () => {
    await onboarded(OWNER + 71);
    const n = sent.length;
    await cb(OWNER + 71, 'nv:go:NOPE');
    await cb(OWNER + 71, 'nv:back:NOWHERE');
    expect(sent.length).toBe(n);
  });
});
