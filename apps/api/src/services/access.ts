/**
 * access.ts — контур допуска бота (ADR-0001, аудит S4/S5):
 *   владелец → авто-бутстрап по OWNER_TELEGRAM_ID;
 *   незнакомец + /start <код> → одноразовый инвайт;
 *   незнакомец без кода → тишина (никаких ответов и записей о нём);
 *   известный пользователь → онбординг → команды (/plan /spent /week /profile…).
 *
 * Никогда не логируем текст сообщений, токены, коды приглашений и их хэши.
 */
import { accessRepo, scoped, type UserRow } from '../db/repo';
import type { SendMessageOpts, TelegramClient } from '../telegram/client';
import { INVITE_TTL_MS, MAX_ACTIVE_INVITES, TEXT, inviteLink } from '../bot/commands';
import { advance, onCcyResult, startOnboarding, type ObEffect, type ObInput, type ObState } from '../bot/onboarding';
import { convert, round2 } from '../domain/money';
import { fmtMoney } from '../bot/format';
import { monthInTz, parseAmount, todayInTz, weekStartInTz } from '../bot/parse';
import { handleExCategory, runIncome, runPlan, runProfile, runReport, runSpent, runWeek } from '../bot/features';
import type { Period } from '../domain/report';
import {
  advancePf,
  cancelTarget,
  onPfCcyResult,
  PF_STEPS,
  renderPf,
  type PfCtx,
  type PfEffect,
  type PfState,
} from '../bot/profile';
import {
  advanceDebt,
  DEBT_SCREENS,
  DEBT_STEPS,
  debtCancelTarget,
  renderDebt,
  type DebtEffect,
  type DebtState,
} from '../bot/debts';
import { buildDebtCtx } from './debts';
import {
  advanceLoan,
  LOAN_SCREENS,
  LOAN_STEPS,
  loanCancelTarget,
  renderLoan,
  type LoanEffect,
  type LoanState,
} from '../bot/loans';
import { buildLoanCtx } from './loans';
import {
  advanceFx,
  FX_SCREENS,
  FX_STEPS,
  fxCancelTarget,
  renderFx,
  type FxEffect,
  type FxState,
} from '../bot/fxan';
import { buildFxCtx } from './fx';
import { baselineIncome } from './baseline';
import { getScreen, homeMarkup, NAV_HOME } from '../bot/nav/nav';
import type { FxProvider } from '../fx/provider';
import { getFxRates } from '../fx/service';
import { handleVisionPhoto, handleVsCallback, type VisionProviders } from './vision';

export interface IncomingMessage {
  chatId: number;
  fromId: number;
  firstName: string | null;
  text: string;
  updateId: number;
  /** file_id самого крупного размера фото или документа-картинки (шаг 7, vision). */
  photoFileId?: string | undefined;
  /** MIME изображения (photo → 'image/jpeg'; document → его mime_type). */
  photoMime?: string | undefined;
}

export interface AccessDeps {
  db: D1Database;
  telegram: TelegramClient;
  ownerTelegramId?: string | undefined;
  botUsername?: string | undefined;
  fx?: FxProvider;
  now?: Date;
  /** Ключи/настройки vision-провайдеров (Gemini/Groq) — из env или моков. */
  vision?: VisionProviders | undefined;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const CMD = (name: string) => new RegExp(`^/${name}(?:@\\w+)?(\\s|$)`);
const START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?$/;
const MENU: Record<string, string> = {
  '📊 План': '/plan',
  '📅 Неделя': '/week',
  '➕ Трата': '/spent',
  '💵 Доход': '/income',
  '🏦 Кредиты': '/credits',
  '🤝 Долги': '/loans',
  '💱 Курсы': '/fx',
  '📈 Отчёт': '/report',
  '⚙️ Профиль': '/profile',
};
/** pf-шаги, ждущие текстового ввода (остальные pf-шаги — навигация). */
const PF_TEXT_STEPS = new Set([
  'edit_expense',
  'edit_typical',
  'edit_living',
  'edit_commit_amount',
  'edit_commit_day',
  'add_commit',
  'add_commit_cad',
  'edit_cpay',
  'edit_income_ccy',
  'edit_living_ccy',
  'edit_tz',
  'edit_tz_custom',
]);
/** debt-шаги, ждущие текстового ввода (freq — только кнопки). */
const DEBT_TEXT_STEPS = new Set([
  'debt:add:name',
  'debt:add:balance',
  'debt:add:rate',
  'debt:add:payment',
  'debt:add:due',
  'debt:add:epoch',
  'debt:pay',
  'debt:pp:ask',
  'debt:recon',
  'debt:edit:rate',
  'debt:edit:payment',
  'debt:edit:day',
  'debt:ev:edit',
]);
/** loan-шаги, ждущие текстового ввода (dir — только кнопки). */
const LOAN_TEXT_STEPS = new Set([
  'loan:add:name',
  'loan:add:amount',
  'loan:add:due',
  'loan:add:note',
  'loan:repay',
  'loan:due',
  'loan:ev:edit',
]);
/** fx-шаги, ждущие текстового ввода (выбор валют — и кнопки, и текст). */
const FX_TEXT_STEPS = new Set([
  'fx:add:from',
  'fx:add:to',
  'fx:add:amounts',
  'fx:add:date',
  'fx:add:note',
  'fx:e:amounts',
  'fx:e:date',
  'fx:e:note',
]);
const STALE_MS = 24 * 3600 * 1000;

const fxAdapter = (deps: AccessDeps) => ({
  get: (ccys: string[]) => getFxRates(deps.db, deps.fx!, ccys, deps.now ?? new Date()),
});

const KB_CLAIM_KIND = 'kb_removed';
const KB_CLAIM_KEY = 'v1';

/**
 * Одноразовая миграция нижней reply-клавиатуры (контракт R5: навигация —
 * только inline + /menu). Показанная когда-то клавиатура висит у клиента,
 * пока бот явно не пошлёт remove_keyboard: перед первым сообщением
 * пользователю шлём служебное «·» с remove_keyboard. Claim в reminder_log
 * (INSERT OR IGNORE) делает отправку «ровно один раз на пользователя»;
 * сбой отправки снимает claim — ретрай со следующим сообщением. Само
 * сообщение — пассажир: ошибка миграции не должна его ломать.
 */
async function sendWithKeyboardMigration(
  repo: ReturnType<typeof scoped>,
  tg: TelegramClient,
  chatId: number | string,
  text: string,
  opts?: SendMessageOpts,
): Promise<void> {
  try {
    const claim = await repo.claimReminder(KB_CLAIM_KIND, KB_CLAIM_KEY);
    if (claim.meta.changes === 1) {
      try {
        await tg.sendMessage(chatId, '·', {
          disableNotification: true,
          replyMarkup: { remove_keyboard: true },
        });
      } catch {
        // отправка не удалась — освобождаем claim, миграция ретраится позже
        await repo.releaseReminder(KB_CLAIM_KIND, KB_CLAIM_KEY).catch(() => undefined);
      }
    }
  } catch {
    /* упал сам claim-запрос — миграцию пропускаем, сообщение всё равно шлём */
  }
  await tg.sendMessage(chatId, text, opts);
}

/**
 * TelegramClient, чей sendMessage пропускается через kb-миграцию.
 * Все исходящие текстовые ответы идут через него; sendDocument — как был.
 */
export function tgWithKeyboardMigration(repo: ReturnType<typeof scoped>, tg: TelegramClient): TelegramClient {
  return {
    ...tg,
    sendMessage: (chatId, text, opts) => sendWithKeyboardMigration(repo, tg, chatId, text, opts),
  };
}

/** Выполнение эффектов редьюсера (единственное место I/O онбординга). */
async function runEffects(
  effects: ObEffect[],
  msg: IncomingMessage,
  user: UserRow,
  deps: AccessDeps,
  state: ObState,
): Promise<void> {
  const tg = deps.telegram;
  const repo = scoped(deps.db, user.id);
  for (const e of effects) {
    if (e.kind === 'send') await tg.sendMessage(msg.chatId, e.text, e.markup ? { replyMarkup: e.markup } : {});
    else if (e.kind === 'consent') await repo.grantConsent('terms');
    else if (e.kind === 'persist') {
      const d = e.data; // финальные данные — state уже null
      const livingMinor = d.livingMinor ?? 0;
      await repo.deactivateAllCommitments();
      await repo.upsertProfile({
        base_currency: 'USD',
        income_currency: d.incomeCcy ?? 'USD',
        living_currency: d.livingCcy ?? d.incomeCcy ?? 'USD',
        timezone: d.tz ?? 'UTC',
        income_minor: d.incomeMinor ?? 0,
        living_cap_minor: livingMinor,
        weekly_budget_minor: Math.round((livingMinor * 12) / 52),
        bonus_prepay_share: 0,
        bonus_dca_share: 0,
        onboarded_at: (deps.now ?? new Date()).toISOString(),
      });
      for (const c of d.commitments) {
        await repo.addCommitment({
          name: c.name,
          amount_minor: Math.round(c.amount * 100),
          currency: c.currency ?? 'USD',
          due_day: c.dueDay ?? null,
        });
      }
      await repo.clearConversation();
    } else if (e.kind === 'checkCcy') {
      try {
        await fxAdapter(deps).get([e.code]);
        await applyOnboarding(onCcyResult(state, true), msg, user, deps);
      } catch {
        await applyOnboarding(onCcyResult(state, false), msg, user, deps);
      }
      return;
    }
  }
}

/**
 * Применить результат редьюсера с CAS: запись допустима, только если
 * текущий шаг в БД всё ещё expectedStep (гонка двух апдейтов → проигравший
 * не шлёт эффекты и не делает persist дважды).
 */
async function applyOnboarding(
  r: { state: ObState | null; effects: ObEffect[] },
  msg: IncomingMessage,
  user: UserRow,
  deps: AccessDeps,
  expectedStep?: string,
): Promise<void> {
  const repo = scoped(deps.db, user.id);
  if (r.state) {
    if (expectedStep !== undefined) {
      const w = await repo.setConversationExpected(r.state.step, JSON.stringify(r.state.data), expectedStep);
      if (w.meta.changes === 0) return; // состояние перехватил другой апдейт — молчим
    } else {
      await repo.setConversation(r.state.step, JSON.stringify(r.state.data));
    }
  } else if (expectedStep !== undefined) {
    const w = await repo.clearConversationExpected(expectedStep);
    if (w.meta.changes === 0) return;
  } else {
    await repo.clearConversation();
  }
  await runEffects(r.effects, msg, user, deps, r.state ?? { step: 'terms', data: { commitments: [] } });
}

/** Текущее состояние диалога (или запуск). Старше 24ч → перезапуск/очистка. */
async function currentOb(
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
  onboarded = false,
): Promise<{ state: ObState | null; effects: ObEffect[] } | null> {
  const conv = await repo.getConversation();
  if (!conv) return null;
  const now = deps.now ?? new Date();
  if (now.getTime() - Date.parse(conv.updated_at) > STALE_MS) {
    if (onboarded) {
      await repo.clearConversation(); // онбоарденный — гасим, онбординг не рестартуем
      return null;
    }
    return startOnboarding(); // устарело — вежливый рестарт с шага 1
  }
  return { state: { step: conv.step as ObState['step'], data: JSON.parse(conv.data) as ObState['data'] }, effects: [] };
}

// ── pf-флоу: контекст и выполнение эффектов ──
async function pfCtx(
  repo: ReturnType<typeof scoped>,
  p: import('../db/repo').ProfileRow,
  deps?: AccessDeps,
): Promise<PfCtx> {
  const month = monthInTz(p.timezone, deps?.now ?? new Date());
  const incomeEntries = (await repo.listIncomeEntries(month)).results;
  let incomeTotal: string | undefined;
  if (deps) {
    try {
      const fxr = await fxAdapter(deps).get([p.income_currency, ...incomeEntries.map((e) => e.currency)]);
      const sum = incomeEntries.reduce(
        (s, e) => s + convert(e.amount_minor / 100, e.currency, p.income_currency, { perUsd: fxr.perUsd }),
        0,
      );
      incomeTotal = fmtMoney(round2(sum), p.income_currency);
    } catch {
      incomeTotal = '—';
    }
  }
  const now = deps?.now ?? new Date();
  const today = todayInTz(p.timezone, now);
  const expenses = (await repo.listExpenses(weekStartInTz(p.timezone, now))).results;
  // журнал оплат за ~год: «оплачен в этом месяце» + последние 5 для карточки
  const since = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}-01`;
  // расчётный базовый доход (income_minor=0) — для подписи в разделе «Доход»;
  // best-effort: без FX показываем только состав («платежи + бюджет + кредиты»)
  let baseline: PfCtx['baseline'];
  if (!p.income_minor && deps?.fx) {
    try {
      const b = await baselineIncome(repo, p, fxAdapter(deps), today);
      if (b.source === 'computed') baseline = { amount: b.amount, currency: b.currency };
    } catch {
      baseline = undefined;
    }
  }
  return {
    profile: p,
    commitments: (await repo.listCommitments(false)).results,
    commitPayments: (await repo.listCommitmentPaymentsSince(since)).results,
    incomeEntries,
    expenses,
    categories: (await repo.listCategories(true)).results,
    month,
    today,
    incomeTotal,
    baseline,
  };
}

async function runPfEffects(
  effects: PfEffect[],
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
  state: PfState,
): Promise<void> {
  const tg = deps.telegram;
  for (const e of effects) {
    if (e.kind === 'send') await tg.sendMessage(msg.chatId, e.text, e.markup ? { replyMarkup: e.markup } : {});
    else if (e.kind === 'patch') await repo.patchProfile(e.patch);
    else if (e.kind === 'commit_add')
      await repo.addCommitment({
        name: e.c.name,
        amount_minor: Math.round(e.c.amount * 100),
        currency: e.c.currency ?? 'USD',
        due_day: e.c.dueDay ?? null,
        frequency: e.c.frequency ?? 'monthly',
        interval_days: e.c.intervalDays ?? null,
        anchor_on: e.c.anchorOn ?? null,
        due_month: e.c.dueMonth ?? null,
        every_months: e.c.everyMonths ?? 1,
      });
    else if (e.kind === 'commit_patch') await repo.patchCommitment(e.id, e.patch);
    else if (e.kind === 'commit_del') await repo.deleteCommitment(e.id);
    else if (e.kind === 'cpay_add') {
      const c = await repo.getCommitment(e.id);
      if (c) {
        const p0 = await repo.getProfile();
        const on = p0 ? todayInTz(p0.timezone, deps.now ?? new Date()) : new Date().toISOString().slice(0, 10);
        // идемпотентность повторной доставки webhook: tg:<update_id>
        await repo.addCommitmentPayment({
          commitment_id: c.id,
          amount_minor: c.amount_minor,
          currency: c.currency,
          paid_on: on,
          source: 'manual',
          source_key: `tg:${msg.updateId}`,
        });
      }
    } else if (e.kind === 'cpay_patch') await repo.updateCommitmentPayment(e.id, e.patch);
    else if (e.kind === 'cpay_del') await repo.deleteCommitmentPayment(e.id);
    else if (e.kind === 'income_del') await repo.deleteIncomeEntry(e.id);
    else if (e.kind === 'expense_del') await repo.deleteExpense(e.id);
    else if (e.kind === 'expense_patch') await repo.patchExpense(e.id, e.patch);
    else if (e.kind === 'render') {
      // экран рендерится ПОСЛЕ мутаций — ctx перечитываем из БД
      const p0 = await repo.getProfile();
      if (p0) {
        const ctx = await pfCtx(repo, p0, deps);
        const r = renderPf(e.screen, e.data ?? {}, ctx);
        await tg.sendMessage(msg.chatId, (e.prefix ?? '') + r.text, r.markup ? { replyMarkup: r.markup } : {});
      }
    } else if (e.kind === 'export') {
      // рейт-лимит: один экспорт в минуту (claim по бакету минуты)
      const bucket = String(Math.floor((deps.now?.getTime() ?? Date.now()) / 60000));
      const claim = await repo.claimReminder('export', bucket);
      if (claim.meta.changes === 0) {
        await tg.sendMessage(msg.chatId, 'Экспорт можно запросить раз в минуту — подождите немного.');
      } else {
        const data = await repo.exportUserData();
        const today = (deps.now ?? new Date()).toISOString().slice(0, 10);
        await tg.sendDocument(msg.chatId, `budget-export-${today}.json`, JSON.stringify(data, null, 2));
      }
    } else if (e.kind === 'delete_me') {
      // прощальное сообщение — ДО удаления: kb-миграция внутри sendMessage
      // писала бы claim в reminder_log уже удалённого пользователя
      await tg.sendMessage(msg.chatId, 'Данные удалены. Если понадоблюсь снова — /start.');
      await repo.deleteAllUserData(); // batch: все таблицы с user_id + users
    } else if (e.kind === 'checkCcy') {
      try {
        await fxAdapter(deps).get([e.code]);
        await applyPf(onPfCcyResult(state, true), msg, repo, deps, state.step);
      } catch {
        await applyPf(onPfCcyResult(state, false), msg, repo, deps, state.step);
      }
      return;
    }
  }
}

async function applyPf(
  r: { state: PfState | null; effects: PfEffect[] },
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
  expectedStep?: string,
): Promise<void> {
  if (r.state) {
    if (expectedStep !== undefined) {
      const w = await repo.setConversationExpected(r.state.step, JSON.stringify(r.state.data), expectedStep);
      if (w.meta.changes === 0) return; // гонка — проигравший молчит
    } else {
      await repo.setConversation(r.state.step, JSON.stringify(r.state.data));
    }
  } else if (expectedStep !== undefined) {
    const w = await repo.clearConversationExpected(expectedStep);
    if (w.meta.changes === 0) return;
  } else {
    await repo.clearConversation();
  }
  await runPfEffects(r.effects, msg, repo, deps, r.state ?? { step: 'pf', data: {} });
}

// ── debt-флоу: контекст и выполнение эффектов ──
const debtCtx = (repo: ReturnType<typeof scoped>, p: import('../db/repo').ProfileRow, deps: AccessDeps) =>
  buildDebtCtx(repo, p, fxAdapter(deps).get, deps.now ?? new Date());

async function runDebtEffects(
  effects: DebtEffect[],
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
): Promise<void> {
  const tg = deps.telegram;
  for (const e of effects) {
    if (e.kind === 'send') await tg.sendMessage(msg.chatId, e.text, e.markup ? { replyMarkup: e.markup } : {});
    else if (e.kind === 'debt_add')
      await repo.addDebt({
        name: e.d.name,
        currency: e.d.currency,
        rate: e.d.rate,
        frequency: e.d.frequency,
        initial_balance_minor: e.d.amountMinor,
        initial_payment_minor: e.d.paymentMinor,
        epoch: e.d.epoch,
        due_day: e.d.dueDay,
      });
    else if (e.kind === 'debt_event') {
      await repo.addDebtEvent({
        debt_id: e.id,
        kind: e.ev.kind,
        amount_minor: e.ev.amountMinor,
        event_on: e.ev.eventOn,
        mode: e.ev.mode ?? null,
        source: 'manual',
        // идемпотентность повторной доставки webhook: tg:<update_id>
        source_key: `tg:${msg.updateId}`,
      });
    } else if (e.kind === 'debt_event_patch') await repo.updateDebtEvent(e.id, e.patch);
    else if (e.kind === 'debt_event_del') await repo.deleteDebtEvent(e.id);
    else if (e.kind === 'debt_patch') await repo.patchDebt(e.id, e.patch);
    else if (e.kind === 'debt_del') await repo.deleteDebt(e.id);
    else if (e.kind === 'render') {
      // экран рендерится ПОСЛЕ мутаций — ctx перечитываем из БД
      const p0 = await repo.getProfile();
      if (p0) {
        const ctx = await debtCtx(repo, p0, deps);
        const r = renderDebt(e.screen, e.data ?? {}, ctx);
        await tg.sendMessage(msg.chatId, (e.prefix ?? '') + r.text, r.markup ? { replyMarkup: r.markup } : {});
      }
    }
  }
}

async function applyDebt(
  r: { state: DebtState | null; effects: DebtEffect[] },
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
  expectedStep?: string,
): Promise<void> {
  if (r.state) {
    if (expectedStep !== undefined) {
      const w = await repo.setConversationExpected(r.state.step, JSON.stringify(r.state.data), expectedStep);
      if (w.meta.changes === 0) return; // гонка — проигравший молчит
    } else {
      await repo.setConversation(r.state.step, JSON.stringify(r.state.data));
    }
  } else if (expectedStep !== undefined) {
    const w = await repo.clearConversationExpected(expectedStep);
    if (w.meta.changes === 0) return;
  } else {
    await repo.clearConversation();
  }
  await runDebtEffects(r.effects, msg, repo, deps);
}

/** /debts — список долгов (экран DEBTS). */
async function runDebts(msg: IncomingMessage, repo: ReturnType<typeof scoped>, deps: AccessDeps): Promise<void> {
  const tg = deps.telegram;
  const p = await repo.getProfile();
  if (!p) {
    await tg.sendMessage(msg.chatId, 'Профиль не настроен — /start');
    return;
  }
  const ctx = await debtCtx(repo, p, deps);
  const r = renderDebt('DEBTS', {}, ctx);
  await repo.setConversation(r.step, '{}'); // меню активно — кнопки живут 24ч
  await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
}

// ── loan-флоу («Долги людям»): контекст и выполнение эффектов ──
const loanCtx = (repo: ReturnType<typeof scoped>, p: import('../db/repo').ProfileRow, deps: AccessDeps) =>
  buildLoanCtx(repo, p, fxAdapter(deps).get, deps.now ?? new Date());

async function runLoanEffects(
  effects: LoanEffect[],
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
): Promise<void> {
  const tg = deps.telegram;
  for (const e of effects) {
    if (e.kind === 'send') await tg.sendMessage(msg.chatId, e.text, e.markup ? { replyMarkup: e.markup } : {});
    else if (e.kind === 'loan_add')
      await repo.addLoan({
        counterparty: e.d.counterparty,
        direction: e.d.direction,
        amount_minor: e.d.amountMinor,
        currency: e.d.currency,
        due_on: e.d.dueOn,
        note: e.d.note,
      });
    else if (e.kind === 'loan_repay') {
      const p0 = await repo.getProfile();
      const on = p0 ? todayInTz(p0.timezone, deps.now ?? new Date()) : new Date().toISOString().slice(0, 10);
      await repo.addLoanEvent({ loan_id: e.id, amount_minor: e.amountMinor, event_on: e.eventOn ?? on, source: 'manual', source_key: null });
    } else if (e.kind === 'loan_due') await repo.patchLoan(e.id, { due_on: e.dueOn });
    else if (e.kind === 'loan_close') await repo.closeLoan(e.id);
    else if (e.kind === 'loan_del') await repo.deleteLoan(e.id);
    else if (e.kind === 'loan_event_patch') await repo.updateLoanEvent(e.id, e.patch);
    else if (e.kind === 'loan_event_del') await repo.deleteLoanEvent(e.id);
    else if (e.kind === 'render') {
      // экран рендерится ПОСЛЕ мутаций — ctx перечитываем из БД
      const p0 = await repo.getProfile();
      if (p0) {
        const ctx = await loanCtx(repo, p0, deps);
        const r = renderLoan(e.screen, e.data ?? {}, ctx);
        await tg.sendMessage(msg.chatId, (e.prefix ?? '') + r.text, r.markup ? { replyMarkup: r.markup } : {});
      }
    }
  }
}

async function applyLoan(
  r: { state: LoanState | null; effects: LoanEffect[] },
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
  expectedStep?: string,
): Promise<void> {
  if (r.state) {
    if (expectedStep !== undefined) {
      const w = await repo.setConversationExpected(r.state.step, JSON.stringify(r.state.data), expectedStep);
      if (w.meta.changes === 0) return; // гонка — проигравший молчит
    } else {
      await repo.setConversation(r.state.step, JSON.stringify(r.state.data));
    }
  } else if (expectedStep !== undefined) {
    const w = await repo.clearConversationExpected(expectedStep);
    if (w.meta.changes === 0) return;
  } else {
    await repo.clearConversation();
  }
  await runLoanEffects(r.effects, msg, repo, deps);
}

/** /loans — список личных займов (экран LOANS). */
async function runLoans(msg: IncomingMessage, repo: ReturnType<typeof scoped>, deps: AccessDeps): Promise<void> {
  const tg = deps.telegram;
  const p = await repo.getProfile();
  if (!p) {
    await tg.sendMessage(msg.chatId, 'Профиль не настроен — /start');
    return;
  }
  const ctx = await loanCtx(repo, p, deps);
  const r = renderLoan('LOANS', {}, ctx);
  await repo.setConversation(r.step, '{}'); // меню активно — кнопки живут 24ч
  await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
}

// ── fx-флоу («Курсы»): контекст и выполнение эффектов ──
const fxCtx = (repo: ReturnType<typeof scoped>, p: import('../db/repo').ProfileRow, deps: AccessDeps) =>
  buildFxCtx(repo, p, deps.fx!, deps.now ?? new Date());

async function runFxEffects(
  effects: FxEffect[],
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
): Promise<void> {
  const tg = deps.telegram;
  for (const e of effects) {
    if (e.kind === 'send') await tg.sendMessage(msg.chatId, e.text, e.markup ? { replyMarkup: e.markup } : {});
    else if (e.kind === 'fx_add') {
      // market_rate — текущий рынок из getFxRates (кэш+fallback); недоступен → null
      let market: number | null = null;
      try {
        const r = await fxAdapter(deps).get([e.d.from, e.d.to]);
        market = r.perUsd[e.d.to]! / r.perUsd[e.d.from]!;
      } catch {
        market = null;
      }
      await repo.addExchange({
        from_ccy: e.d.from,
        to_ccy: e.d.to,
        amount_from_minor: e.d.amountFromMinor,
        amount_to_minor: e.d.amountToMinor,
        market_rate: market,
        spent_on: e.d.spentOn,
        note: e.d.note,
        source: 'manual',
        source_key: `tg:${msg.updateId}`,
      });
    } else if (e.kind === 'fx_patch') {
      // пересчитываем rate при изменении сумм — читаем строку и мёрджим
      const row = await repo.getExchange(e.id);
      if (row) {
        const patch: {
          amount_from_minor?: number;
          amount_to_minor?: number;
          spent_on?: string;
          note?: string;
          rate?: number;
        } = { ...e.patch };
        if (patch.amount_from_minor !== undefined || patch.amount_to_minor !== undefined) {
          const af = patch.amount_from_minor ?? row.amount_from_minor;
          const at = patch.amount_to_minor ?? row.amount_to_minor;
          if (af > 0) patch.rate = at / af;
        }
        await repo.patchExchange(e.id, patch);
      }
    } else if (e.kind === 'fx_del') await repo.deleteExchange(e.id);
    else if (e.kind === 'render') {
      // экран рендерится ПОСЛЕ мутаций — ctx перечитываем из БД
      const p0 = await repo.getProfile();
      if (p0) {
        const ctx = await fxCtx(repo, p0, deps);
        const r = renderFx(e.screen, e.data ?? {}, ctx);
        await tg.sendMessage(msg.chatId, (e.prefix ?? '') + r.text, r.markup ? { replyMarkup: r.markup } : {});
      }
    }
  }
}

async function applyFx(
  r: { state: FxState | null; effects: FxEffect[] },
  msg: IncomingMessage,
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
  expectedStep?: string,
): Promise<void> {
  if (r.state) {
    if (expectedStep !== undefined) {
      const w = await repo.setConversationExpected(r.state.step, JSON.stringify(r.state.data), expectedStep);
      if (w.meta.changes === 0) return; // гонка — проигравший молчит
    } else {
      await repo.setConversation(r.state.step, JSON.stringify(r.state.data));
    }
  } else if (expectedStep !== undefined) {
    const w = await repo.clearConversationExpected(expectedStep);
    if (w.meta.changes === 0) return;
  } else {
    await repo.clearConversation();
  }
  await runFxEffects(r.effects, msg, repo, deps);
}

/** /fx — анализ курсов + журнал обменов (экран FX_HUB). */
async function runFx(msg: IncomingMessage, repo: ReturnType<typeof scoped>, deps: AccessDeps): Promise<void> {
  const tg = deps.telegram;
  const p = await repo.getProfile();
  if (!p) {
    await tg.sendMessage(msg.chatId, 'Профиль не настроен — /start');
    return;
  }
  const ctx = await fxCtx(repo, p, deps);
  const r = renderFx('FX_HUB', {}, ctx);
  await repo.setConversation(r.step, '{}'); // меню активно — кнопки живут 24ч
  await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
}

/** Точка входа для известного пользователя: онбординг или команды. */
async function knownUser(msg: IncomingMessage, user: UserRow, deps: AccessDeps): Promise<void> {
  const repo = scoped(deps.db, user.id);
  // Все исходящие тексты — через одноразовую миграцию снятия reply-клавиатуры.
  deps = { ...deps, telegram: tgWithKeyboardMigration(repo, deps.telegram) };
  const tg = deps.telegram;
  const profile = await repo.getProfile();
  // Фото имеет приоритет над текстовой маршрутизацией (подпись игнорируется);
  // ждущие текстовые шаги фото не кормит и состояние не чистит.
  if (profile?.onboarded_at && msg.photoFileId) {
    await handleVisionPhoto(msg, repo, deps, profile);
    return;
  }
  const text = msg.text.trim();

  // Активный диалог — ввод туда (кроме /cancel — см. ниже).
  const conv = await currentOb(repo, deps, !!profile?.onboarded_at);

  // /cancel — отмена диалога с возвратом на экран-источник (R2/R3).
  if (/^\/cancel(?:@\w+)?\s*$/.test(text)) {
    if (conv?.state && profile?.onboarded_at) {
      if ((conv.state.step as string) in DEBT_STEPS) {
        const target = debtCancelTarget(conv.state as DebtState);
        if (target === 'HOME') {
          await repo.clearConversation();
          await tg.sendMessage(msg.chatId, 'Настройка отменена.', { replyMarkup: homeMarkup() });
          return;
        }
        const ctx = await debtCtx(repo, profile, deps);
        const data = (conv.state as DebtState).data ?? {};
        const r = renderDebt(target, data, ctx);
        await repo.setConversation(r.step, JSON.stringify(data));
        await tg.sendMessage(msg.chatId, `Отменено.\n\n${r.text}`, r.markup ? { replyMarkup: r.markup } : {});
        return;
      }
      if ((conv.state.step as string) in LOAN_STEPS) {
        const target = loanCancelTarget(conv.state as LoanState);
        if (target === 'HOME') {
          await repo.clearConversation();
          await tg.sendMessage(msg.chatId, 'Настройка отменена.', { replyMarkup: homeMarkup() });
          return;
        }
        const ctx = await loanCtx(repo, profile, deps);
        const data = (conv.state as LoanState).data ?? {};
        const r = renderLoan(target, data, ctx);
        await repo.setConversation(r.step, JSON.stringify(data));
        await tg.sendMessage(msg.chatId, `Отменено.\n\n${r.text}`, r.markup ? { replyMarkup: r.markup } : {});
        return;
      }
      if ((conv.state.step as string) in FX_STEPS) {
        const target = fxCancelTarget(conv.state as FxState);
        if (target === 'HOME') {
          await repo.clearConversation();
          await tg.sendMessage(msg.chatId, 'Настройка отменена.', { replyMarkup: homeMarkup() });
          return;
        }
        const ctx = await fxCtx(repo, profile, deps);
        const data = (conv.state as FxState).data ?? {};
        const r = renderFx(target, data, ctx);
        await repo.setConversation(r.step, JSON.stringify(data));
        await tg.sendMessage(msg.chatId, `Отменено.\n\n${r.text}`, r.markup ? { replyMarkup: r.markup } : {});
        return;
      }
      const target = cancelTarget(conv.state as PfState);
      if (target === 'HOME') {
        await repo.clearConversation();
        await tg.sendMessage(msg.chatId, 'Настройка отменена.', { replyMarkup: homeMarkup() });
        return;
      }
      const ctx = await pfCtx(repo, profile, deps);
      const data = (conv.state as PfState).data ?? {};
      const r = renderPf(target, data, ctx);
      await repo.setConversation(r.step, JSON.stringify(data));
      await tg.sendMessage(msg.chatId, `Отменено.\n\n${r.text}`, r.markup ? { replyMarkup: r.markup } : {});
      return;
    }
    if (conv) {
      await repo.clearConversation();
      await tg.sendMessage(msg.chatId, 'Настройка отменена. /start — начать заново.');
    } else {
      await tg.sendMessage(msg.chatId, 'Нечего отменять.');
    }
    return;
  }

  if (conv) {
    if (conv.effects.length) {
      // устаревшее состояние — мягкий рестарт с первого шага
      await runEffects(conv.effects, msg, user, deps, conv.state!);
      return;
    }
    const step = conv.state!.step as string;
    if (step === 'spent_ask' || step === 'income_ask') {
      // ждём сумму: команда/кнопка меню — отменяем вопрос и идём к ней,
      // сумма — записываем, мусор — ошибка, вопрос остаётся активным.
      if (!text.startsWith('/') && !MENU[text]) {
        try {
          parseAmount(text);
        } catch (e) {
          await tg.sendMessage(msg.chatId, (e as Error).message);
          return;
        }
        await repo.clearConversation();
        const tz = profile?.timezone ?? 'UTC';
        const now = deps.now ?? new Date();
        if (step === 'spent_ask')
          await runSpent(msg.chatId, tg, repo, fxAdapter(deps), text, `tg:${msg.updateId}`, todayInTz(tz, now));
        else {
          const saved = await runIncome(
            msg.chatId,
            tg,
            repo,
            fxAdapter(deps),
            text,
            `tg:${msg.updateId}`,
            monthInTz(tz, now),
          );
          if (saved) {
            // после записи — экран INCOME_HUB (R3)
            const p0 = await repo.getProfile();
            if (p0) {
              const ctx = await pfCtx(repo, p0, deps);
              const r = renderPf('INCOME_HUB', conv.state!.data ?? {}, ctx);
              await repo.setConversation(r.step, JSON.stringify(conv.state!.data ?? {}));
              await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
            }
          }
        }
        return;
      }
      await repo.clearConversation();
      // проваливаемся к обычной диспетчеризации команды
    } else if (step in PF_STEPS) {
      if (PF_TEXT_STEPS.has(step) && !text.startsWith('/') && !MENU[text]) {
        // текст — ввод для редактируемого шага
        const p0 = await repo.getProfile();
        if (!p0) {
          await repo.clearConversation();
          return;
        }
        const ctx = await pfCtx(repo, p0);
        await applyPf(advancePf(conv.state!, { type: 'text', text }, ctx), msg, repo, deps, step);
        return;
      }
      // навигационный pf-экран: произвольный текст — не команда и не ввод,
      // состояние (кнопки экрана) сохраняем
      if (!text.startsWith('/') && !MENU[text]) {
        await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
        return;
      }
      // команда/кнопка с навигационного экрана или во время правки — уходим к ней
      await repo.clearConversation();
    } else if (step in DEBT_STEPS) {
      if (DEBT_TEXT_STEPS.has(step) && !text.startsWith('/') && !MENU[text]) {
        // текст — ввод для шага мастера долга
        const p0 = await repo.getProfile();
        if (!p0) {
          await repo.clearConversation();
          return;
        }
        const ctx = await debtCtx(repo, p0, deps);
        await applyDebt(advanceDebt(conv.state! as DebtState, { type: 'text', text }, ctx), msg, repo, deps, step);
        return;
      }
      // навигационный debt-экран: произвольный текст — не ввод, состояние живёт
      if (!text.startsWith('/') && !MENU[text]) {
        await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
        return;
      }
      // команда/кнопка с экрана или во время мастера — уходим к ней
      await repo.clearConversation();
    } else if (step in LOAN_STEPS) {
      if (LOAN_TEXT_STEPS.has(step) && !text.startsWith('/') && !MENU[text]) {
        // текст — ввод для шага займа (мастер или возврат)
        const p0 = await repo.getProfile();
        if (!p0) {
          await repo.clearConversation();
          return;
        }
        const ctx = await loanCtx(repo, p0, deps);
        await applyLoan(advanceLoan(conv.state! as LoanState, { type: 'text', text }, ctx), msg, repo, deps, step);
        return;
      }
      // навигационный loan-экран: произвольный текст — не ввод, состояние живёт
      if (!text.startsWith('/') && !MENU[text]) {
        await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
        return;
      }
      // команда/кнопка с экрана или во время мастера — уходим к ней
      await repo.clearConversation();
    } else if (step in FX_STEPS) {
      if (FX_TEXT_STEPS.has(step) && !text.startsWith('/') && !MENU[text]) {
        // текст — ввод для шага обмена (валюта/суммы/дата/заметка)
        const p0 = await repo.getProfile();
        if (!p0) {
          await repo.clearConversation();
          return;
        }
        const ctx = await fxCtx(repo, p0, deps);
        await applyFx(advanceFx(conv.state! as FxState, { type: 'text', text }, ctx), msg, repo, deps, step);
        return;
      }
      // навигационный fx-экран: произвольный текст — не ввод, состояние живёт
      if (!text.startsWith('/') && !MENU[text]) {
        await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
        return;
      }
      // команда/кнопка с экрана или во время мастера — уходим к ней
      await repo.clearConversation();
    } else if (step === 'vs:recon') {
      // выбор кредита для сверки скриншота: команда — уходим к ней,
      // иной текст — не ввод, состояние (кнопки) сохраняем
      if (!text.startsWith('/') && !MENU[text]) {
        await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
        return;
      }
      await repo.clearConversation();
    } else {
      await applyOnboarding(advance(conv.state!, { type: 'text', text }), msg, user, deps, step);
      return;
    }
  }

  if (!profile?.onboarded_at) {
    // Без согласия/профиля — только онбординг и служебные команды.
    if (START_RE.test(text) || text === '/cancel' || text === '/profile') {
      if (text === '/cancel') {
        await repo.clearConversation();
        await tg.sendMessage(msg.chatId, 'Отменено.');
        return;
      }
      const start = startOnboarding();
      await applyOnboarding(start, msg, user, deps);
      return;
    }
    if (CMD('help').test(text)) {
      await tg.sendMessage(msg.chatId, TEXT.help(user.role));
      return;
    }
    if (CMD('id').test(text)) {
      await tg.sendMessage(msg.chatId, TEXT.myId(msg.fromId));
      return;
    }
    if (CMD('invite').test(text)) {
      await createInvite(msg, user, deps, accessRepo(deps.db));
      return;
    }
    await tg.sendMessage(msg.chatId, 'Сначала короткая настройка — /start');
    return;
  }

  // ── онбоарденный пользователь ──
  const cmd = MENU[text] ?? text;
  const tz = profile.timezone;
  const today = todayInTz(tz, deps.now ?? new Date());
  const fx = fxAdapter(deps);
  if (START_RE.test(cmd) || CMD('menu').test(cmd) || text === '🏠 Меню') {
    await tg.sendMessage(msg.chatId, 'Главное меню', { replyMarkup: homeMarkup() });
    return;
  }
  if (CMD('plan').test(cmd)) {
    await runPlan(msg.chatId, tg, repo, fx, cmd.split(/\s+/).slice(1).join(' '));
    return;
  }
  if (CMD('week').test(cmd)) {
    await runWeek(msg.chatId, tg, repo, fx, today);
    return;
  }
  if (CMD('report').test(cmd)) {
    await runReport(msg.chatId, tg, repo, fx, 'month', 0);
    return;
  }
  if (CMD('spent').test(cmd)) {
    const arg = cmd.split(/\s+/).slice(1).join(' ').trim();
    if (arg) {
      await runSpent(msg.chatId, tg, repo, fx, arg, `tg:${msg.updateId}`, today);
      return;
    }
    const r0 = renderPf(
      'SPENT_ASK',
      {},
      {
        profile: (await repo.getProfile())!,
        commitments: [],
        commitPayments: [],
        incomeEntries: [],
        expenses: [],
        categories: [],
        month: monthInTz(tz, deps.now ?? new Date()),
        today,
      },
    );
    await repo.setConversation(r0.step, '{}');
    await tg.sendMessage(msg.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
    return;
  }
  if (CMD('export').test(cmd)) {
    await applyPf(
      { state: conv?.state ?? { step: 'pf:data', data: {} }, effects: [{ kind: 'export' }] },
      msg,
      repo,
      deps,
    );
    return;
  }
  if (CMD('delete_me').test(cmd)) {
    const p0 = await repo.getProfile();
    if (p0) {
      const ctx = await pfCtx(repo, p0, deps);
      const r = renderPf('PF_DELETE_ASK', {}, ctx);
      await repo.setConversation(r.step, '{}');
      await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
    }
    return;
  }
  if (CMD('expenses').test(cmd)) {
    const p0 = await repo.getProfile();
    if (p0) {
      const ctx = await pfCtx(repo, p0, deps);
      const r = renderPf('EXPENSES_LIST', {}, ctx);
      await repo.setConversation(r.step, '{}');
      await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
    }
    return;
  }
  if (CMD('income').test(cmd)) {
    const arg = cmd.split(/\s+/).slice(1).join(' ').trim();
    const month = monthInTz(tz, deps.now ?? new Date());
    if (arg) {
      const saved = await runIncome(msg.chatId, tg, repo, fx, arg, `tg:${msg.updateId}`, month);
      if (saved) {
        // после записи — экран INCOME_HUB (R3)
        const p0 = await repo.getProfile();
        if (p0) {
          const ctx = await pfCtx(repo, p0, deps);
          const r = renderPf('INCOME_HUB', {}, ctx);
          await repo.setConversation(r.step, '{}');
          await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
        }
      }
      return;
    }
    // /income без аргументов → экран INCOME_HUB (итог + кнопки)
    const p0 = await repo.getProfile();
    if (p0) {
      const ctx = await pfCtx(repo, p0, deps);
      const r = renderPf('INCOME_HUB', {}, ctx);
      await repo.setConversation(r.step, '{}');
      await tg.sendMessage(msg.chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
      return;
    }
    await repo.setConversation('income_ask', '{}');
    const r0 = renderPf('INCOME_ASK', {}, await pfCtx(repo, (await repo.getProfile())!, deps));
    await tg.sendMessage(msg.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
    return;
  }
  if (CMD('credits').test(cmd) || CMD('debts').test(cmd)) {
    await runDebts(msg, repo, deps);
    return;
  }
  if (CMD('loans').test(cmd)) {
    await runLoans(msg, repo, deps);
    return;
  }
  if (CMD('fx').test(cmd)) {
    await runFx(msg, repo, deps);
    return;
  }
  if (CMD('profile').test(cmd)) {
    await runProfile(msg.chatId, tg, repo, deps.fx ? fxAdapter(deps) : undefined);
    return;
  }
  if (CMD('help').test(cmd)) {
    await tg.sendMessage(msg.chatId, TEXT.helpOnboarded());
    return;
  }
  if (CMD('id').test(text)) {
    await tg.sendMessage(msg.chatId, TEXT.myId(msg.fromId));
    return;
  }
  if (CMD('invite').test(text)) {
    await createInvite(msg, user, deps, accessRepo(deps.db));
    return;
  }
  // Быстрый ввод: голая сумма вне активного шага — это трата («500 кафе»).
  // Активные шаги (spent_ask/income_ask/онбординг) обрабатываются выше и сюда
  // не доходят.
  let isAmount = true;
  try {
    parseAmount(text);
  } catch {
    isAmount = false; // не сумма — неизвестная команда
  }
  if (isAmount) {
    await runSpent(msg.chatId, tg, repo, fx, text, `tg:${msg.updateId}`, today);
    return;
  }
  await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
}

/** Входящее текстовое сообщение. */
export async function handleMessage(msg: IncomingMessage, deps: AccessDeps): Promise<void> {
  const repo = accessRepo(deps.db);
  const tg = deps.telegram;
  const send = (text: string) => tg.sendMessage(msg.chatId, text);
  const user = await repo.findUserByTelegramId(msg.fromId);
  const ownerId = (deps.ownerTelegramId ?? '').trim();
  const ownerSet = ownerId !== '' && /^\d+$/.test(ownerId);

  if (!user) {
    if (ownerSet && String(msg.fromId) === ownerId) {
      const r = await repo.createUser(msg.fromId, msg.firstName, 'owner');
      const uid = Number(r.meta.last_row_id);
      await repo.audit('owner_bootstrap', uid);
      const stg = tgWithKeyboardMigration(scoped(deps.db, uid), tg);
      await stg.sendMessage(msg.chatId, TEXT.welcomeOwner(msg.firstName));
      return;
    }
    const m = START_RE.exec(msg.text);
    const code = m?.[1];
    if (code) {
      await redeemInvite(msg, code, deps, repo);
      return;
    }
    if (CMD('id').test(msg.text.trim()) && !ownerSet) {
      if (!(await repo.idReplySent(msg.fromId))) {
        await repo.audit('id_reply', null, { tg: msg.fromId });
        await send(TEXT.myId(msg.fromId));
      }
      return;
    }
    return; // незнакомец без кода — тишина
  }
  await knownUser(msg, user, deps);
}

/** Callback-кнопки — только для известных пользователей. */
export async function handleCallback(
  cb: {
    id: string;
    chatId: number;
    fromId: number;
    firstName: string | null;
    data: string;
    updateId?: number;
    /** message_id сообщения с кнопкой — для editMessageText (rp:/ex:cg/ex:sc). */
    messageId?: number | undefined;
  },
  deps: AccessDeps,
): Promise<void> {
  const repo = accessRepo(deps.db);
  const user = await repo.findUserByTelegramId(cb.fromId);
  await deps.telegram.answerCallbackQuery(cb.id);
  if (!user) return; // незнакомец — молча
  const r = scoped(deps.db, user.id);
  // исходящие тексты из callback-ветки — тоже через kb-миграцию
  deps = { ...deps, telegram: tgWithKeyboardMigration(r, deps.telegram) };
  const msg: IncomingMessage = {
    chatId: cb.chatId,
    fromId: cb.fromId,
    firstName: cb.firstName,
    text: '',
    updateId: cb.updateId ?? 0,
  };

  const p0 = await r.getProfile();
  // rp:* (отчёт) и ex:cg/ex:sc (категория траты) — без диалога, правка сообщения.
  if (cb.data.startsWith('rp:')) {
    if (!p0?.onboarded_at) return;
    const m = /^rp:(week|month|quarter|half|year):(-?\d+)$/.exec(cb.data);
    if (!m) return; // невалидный — молча
    const offset = Math.max(-60, Math.min(0, Number(m[2])));
    await runReport(cb.chatId, deps.telegram, r, fxAdapter(deps), m[1] as Period, offset, cb.messageId);
    return;
  }
  if (/^ex:(cg|sc):/.test(cb.data)) {
    if (!p0?.onboarded_at) return;
    const tz = p0.timezone;
    await handleExCategory(
      cb.data,
      cb.chatId,
      cb.messageId,
      r,
      fxAdapter(deps),
      deps.telegram,
      todayInTz(tz, deps.now ?? new Date()),
    );
    return;
  }
  // nv:* — навигация по реестру (R7: чужие/устаревшие — молча)
  if (cb.data === NAV_HOME || /^nv:(back|go):/.test(cb.data)) {
    const target = cb.data === NAV_HOME ? 'HOME' : (/^nv:(?:back|go):(.+)$/.exec(cb.data)?.[1] ?? '');
    if (!getScreen(target)) return; // неизвестный экран — молча
    const navMsg: IncomingMessage = {
      chatId: cb.chatId,
      fromId: cb.fromId,
      firstName: cb.firstName,
      text: '',
      updateId: 0,
    };
    if (target === 'HOME') {
      await r.clearConversation();
      await deps.telegram.sendMessage(cb.chatId, 'Главное меню', {
        replyMarkup: homeMarkup(),
      });
      return;
    }
    if (!p0?.onboarded_at) return;
    // экраны с живой логикой — через обычный диспетчер команд
    const cmd = {
      PLAN: '/plan',
      WEEK: '/week',
      SPENT_ASK: '/spent',
      PF_HOME: '/profile',
      INCOME_HUB: '/income',
      DEBTS: '/debts',
      LOANS: '/loans',
      FX_HUB: '/fx',
      REPORT: '/report',
    }[target];
    if (cmd) {
      await knownUser({ ...navMsg, text: cmd }, user, deps);
      return;
    }
    // debt-экраны — прямой рендер через renderDebt (debtId из состояния диалога)
    if (DEBT_SCREENS.has(target)) {
      const conv0 = await r.getConversation();
      const data = conv0 ? (JSON.parse(conv0.data) as DebtState['data']) : {};
      const ctx = await debtCtx(r, p0, deps);
      const r0 = renderDebt(target, data ?? {}, ctx);
      await r.setConversation(r0.step, JSON.stringify(data ?? {}));
      await deps.telegram.sendMessage(cb.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
      return;
    }
    // loan-экраны — прямой рендер через renderLoan (loanId из состояния диалога)
    if (LOAN_SCREENS.has(target)) {
      const conv0 = await r.getConversation();
      const data = conv0 ? (JSON.parse(conv0.data) as LoanState['data']) : {};
      const ctx = await loanCtx(r, p0, deps);
      const r0 = renderLoan(target, data ?? {}, ctx);
      await r.setConversation(r0.step, JSON.stringify(data ?? {}));
      await deps.telegram.sendMessage(cb.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
      return;
    }
    // fx-экраны — прямой рендер через renderFx (exchangeId из состояния диалога)
    if (FX_SCREENS.has(target)) {
      const conv0 = await r.getConversation();
      const data = conv0 ? (JSON.parse(conv0.data) as FxState['data']) : {};
      const ctx = await fxCtx(r, p0, deps);
      const r0 = renderFx(target, data ?? {}, ctx);
      await r.setConversation(r0.step, JSON.stringify(data ?? {}));
      await deps.telegram.sendMessage(cb.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
      return;
    }
    // остальные pf/income-экраны — прямой рендер через renderPf (данные из conv)
    const conv0 = await r.getConversation();
    const data = (conv0 ? (JSON.parse(conv0.data) as PfState['data']) : {}) ?? {};
    const ctx = await pfCtx(r, p0, deps);
    const r0 = renderPf(target, data, ctx);
    await r.setConversation(r0.step, JSON.stringify(data));
    await deps.telegram.sendMessage(cb.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
    return;
  }
  const conv = await currentOb(r, deps, !!p0?.onboarded_at);
  // ex:* допустим и без разговора (после записи траты conv очищен) — считаем шаг 'pf'
  const st = conv?.state ?? (cb.data.startsWith('ex:') ? ({ step: 'pf', data: {} } as PfState) : undefined);
  if (!st) return;
  const step = st.step as string;
  if (
    cb.data.startsWith('pf:') ||
    cb.data.startsWith('in:') ||
    cb.data.startsWith('inc:') ||
    cb.data.startsWith('ex:')
  ) {
    if (!p0) return;
    if (!(step in PF_STEPS)) return; // чужой шаг — молча
    const ctx = await pfCtx(r, p0);
    // без разговора CAS по шагу не сработает — применяем безусловно
    await applyPf(
      advancePf(st, { type: 'callback', data: cb.data }, ctx),
      msg,
      r,
      deps,
      conv?.state ? step : undefined,
    );
    return;
  }
  if (cb.data.startsWith('dbt:')) {
    if (!p0?.onboarded_at || !conv) return; // без диалога кнопки кредитов мертвы
    if (!(step in DEBT_STEPS)) return; // чужой шаг — молча
    const ctx = await debtCtx(r, p0, deps);
    await applyDebt(advanceDebt(st as DebtState, { type: 'callback', data: cb.data }, ctx), msg, r, deps, step);
    return;
  }
  if (cb.data.startsWith('ln:')) {
    if (!p0?.onboarded_at || !conv) return; // без диалога кнопки займов мертвы
    if (!(step in LOAN_STEPS)) return; // чужой шаг — молча
    const ctx = await loanCtx(r, p0, deps);
    await applyLoan(advanceLoan(st as LoanState, { type: 'callback', data: cb.data }, ctx), msg, r, deps, step);
    return;
  }
  if (cb.data.startsWith('fxa:')) {
    if (!p0?.onboarded_at || !conv) return; // без диалога кнопки обменов мертвы
    if (!(step in FX_STEPS)) return; // чужой шаг — молча
    const ctx = await fxCtx(r, p0, deps);
    await applyFx(advanceFx(st as FxState, { type: 'callback', data: cb.data }, ctx), msg, r, deps, step);
    return;
  }
  // vs:* — сверка остатка со скриншота (vision, шаг 7): живёт только пока
  // активен шаг vs:recon; сумма — в conversation_state, не в callback.
  if (cb.data.startsWith('vs:')) {
    if (!p0?.onboarded_at || !conv) return;
    await handleVsCallback(cb.data, msg, r, deps, conv.state!, p0);
    return;
  }
  const input: ObInput = { type: 'callback', data: cb.data };
  await applyOnboarding(advance(st as ObState, input), msg, user, deps, step);
}

async function createInvite(
  msg: IncomingMessage,
  user: UserRow,
  deps: AccessDeps,
  repo: ReturnType<typeof accessRepo>,
) {
  const tg = deps.telegram;
  if (user.role !== 'owner') {
    await tg.sendMessage(msg.chatId, TEXT.inviteForbidden);
    return;
  }
  const now = new Date();
  const active = await repo.countActiveInvites(user.id, now.toISOString());
  if (active >= MAX_ACTIVE_INVITES) {
    await tg.sendMessage(msg.chatId, TEXT.inviteLimit);
    return;
  }
  const code = newInviteCode();
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  await repo.createInvite(codeHash, user.id, expiresAt);
  await repo.audit('invite_created', user.id, { expires_at: expiresAt });
  await tg.sendMessage(msg.chatId, TEXT.inviteCreated(inviteLink(code, deps.botUsername), code));
}

async function redeemInvite(msg: IncomingMessage, code: string, deps: AccessDeps, repo: ReturnType<typeof accessRepo>) {
  const tg = deps.telegram;
  const codeHash = await sha256Hex(code);
  let r: { redeemed: boolean; userId: number } | undefined;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    try {
      r = await repo.redeemInvite(codeHash, msg.fromId, msg.firstName, new Date().toISOString());
    } catch (e) {
      if (!/locked|busy/i.test(String(e)) || attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 30 * (attempt + 1)));
    }
  }
  const res = r!;
  if (res.redeemed) {
    await repo.audit('invite_redeemed', res.userId);
    const stg = tgWithKeyboardMigration(scoped(deps.db, res.userId), tg);
    await stg.sendMessage(msg.chatId, TEXT.joined(msg.firstName));
    return;
  }
  const reason = await repo.inviteState(codeHash);
  await repo.audit('invite_redeem_failed', null, { reason });
  await tg.sendMessage(msg.chatId, TEXT.inviteInvalid);
}
