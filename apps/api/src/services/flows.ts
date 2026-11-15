/**
 * flows.ts — общий каркас диалоговых мастеров бота (pf/debt/loan/fx).
 *
 * Каждый флоу — данные: реестр шагов, текстовые шаги, ctx, чистый редьюсер,
 * рендер экранов, цель «Отмены» и исполнитель эффектов (единственное место
 * I/O флоу). Маршрутизация (access.ts) работает с флоу через общие хелперы:
 * applyFlow (CAS-запись состояния + эффекты), showScreen, cancelFlow, openHub.
 */
import type { ProfileRow, scoped } from '../db/repo';
import type { ReplyMarkup } from '../telegram/client';
import { convert, round2 } from '../domain/money';
import { fmtMoney } from '../bot/format';
import { monthInTz, todayInTz, weekStartInTz } from '../bot/parse';
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
import { advanceFx, FX_SCREENS, FX_STEPS, fxCancelTarget, renderFx, type FxEffect, type FxState } from '../bot/fxan';
import { buildFxCtx } from './fx';
import { baselineIncome } from './baseline';
import { homeMarkup } from '../bot/nav/nav';
import { getFxRates } from '../fx/service';
import type { AccessDeps, IncomingMessage } from './access';

type Repo = ReturnType<typeof scoped>;

export const fxAdapter = (deps: AccessDeps) => ({
  get: (ccys: string[]) => getFxRates(deps.db, deps.fx!, ccys, deps.now ?? new Date()),
});

// ── каркас ──

export interface FlowState {
  step: string;
  data: object;
}
export type FlowInput = { type: 'text'; text: string } | { type: 'callback'; data: string };
export interface FlowResult<S, E> {
  state: S | null;
  effects: E[];
}

export interface Flow<S extends FlowState, E, C> {
  /** Реестр шагов флоу (`step in flow.steps` — шаг принадлежит флоу). */
  steps: Record<string, string>;
  /** Шаги, ждущие текстового ввода (остальные — навигация кнопками). */
  textSteps: ReadonlySet<string>;
  /** Экраны прямого nv:-рендера (pf — fallback для прочих экранов). */
  screens?: ReadonlySet<string>;
  /** Префикс callback-данных флоу (pf-колбэки маршрутизируются отдельно). */
  cbPrefix?: string;
  /** Полный ctx для рендера экранов. */
  ctx(repo: Repo, p: ProfileRow, deps: AccessDeps): Promise<C>;
  /** ctx для редьюсера (ввод/кнопки); pf — облегчённый, без FX. */
  inputCtx(repo: Repo, p: ProfileRow, deps: AccessDeps): Promise<C>;
  advance(state: S, input: FlowInput, ctx: C): FlowResult<S, E>;
  render(screen: string, data: S['data'], ctx: C): { text: string; markup?: ReplyMarkup | undefined; step: string };
  cancelTarget(state: S): string;
  runEffects(effects: E[], msg: IncomingMessage, repo: Repo, deps: AccessDeps, next: S | null): Promise<void>;
}
export type AnyFlow = Flow<FlowState, unknown, unknown>;

/** CAS-запись состояния диалога; false — гонку проиграли (проигравший молчит). */
async function persistConv(repo: Repo, state: FlowState | null, expectedStep?: string): Promise<boolean> {
  if (state) {
    if (expectedStep === undefined) {
      await repo.setConversation(state.step, JSON.stringify(state.data));
      return true;
    }
    const w = await repo.setConversationExpected(state.step, JSON.stringify(state.data), expectedStep);
    return w.meta.changes !== 0;
  }
  if (expectedStep === undefined) {
    await repo.clearConversation();
    return true;
  }
  return (await repo.clearConversationExpected(expectedStep)).meta.changes !== 0;
}

/** Результат редьюсера: записать состояние (CAS по expectedStep) и выполнить эффекты. */
export async function applyFlow<S extends FlowState, E, C>(
  flow: Flow<S, E, C>,
  r: FlowResult<S, E>,
  msg: IncomingMessage,
  repo: Repo,
  deps: AccessDeps,
  expectedStep?: string,
): Promise<void> {
  if (!(await persistConv(repo, r.state, expectedStep))) return;
  await flow.runEffects(r.effects, msg, repo, deps, r.state);
}

/** Показать экран флоу и сделать его активным шагом (кнопки живут 24ч). */
export async function showScreen<S extends FlowState, E, C>(
  flow: Flow<S, E, C>,
  screen: string,
  data: S['data'],
  chatId: number,
  repo: Repo,
  deps: AccessDeps,
  p: ProfileRow,
  prefix = '',
): Promise<void> {
  const r = flow.render(screen, data, await flow.ctx(repo, p, deps));
  await repo.setConversation(r.step, JSON.stringify(data));
  await deps.telegram.sendMessage(chatId, prefix + r.text, r.markup ? { replyMarkup: r.markup } : {});
}

/** Входной экран флоу по команде (/debts, /loans, /fx). */
export async function openHub(
  flow: AnyFlow,
  screen: string,
  msg: IncomingMessage,
  repo: Repo,
  deps: AccessDeps,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p) {
    await deps.telegram.sendMessage(msg.chatId, 'Профиль не настроен — /start');
    return;
  }
  await showScreen(flow, screen, {}, msg.chatId, repo, deps, p);
}

/** /cancel внутри флоу — возврат на экран-источник (R2/R3) или в меню. */
export async function cancelFlow<S extends FlowState, E, C>(
  flow: Flow<S, E, C>,
  state: S,
  chatId: number,
  repo: Repo,
  deps: AccessDeps,
  p: ProfileRow,
): Promise<void> {
  const target = flow.cancelTarget(state);
  if (target === 'HOME') {
    await repo.clearConversation();
    await deps.telegram.sendMessage(chatId, 'Настройка отменена.', { replyMarkup: homeMarkup() });
    return;
  }
  await showScreen(flow, target, state.data ?? {}, chatId, repo, deps, p, 'Отменено.\n\n');
}

// ── pf-флоу: контекст и выполнение эффектов ──
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

export async function pfCtx(
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
  next: PfState | null,
): Promise<void> {
  const state: PfState = next ?? { step: 'pf', data: {} };
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
        await applyFlow(PF_FLOW, onPfCcyResult(state, true), msg, repo, deps, state.step);
      } catch {
        await applyFlow(PF_FLOW, onPfCcyResult(state, false), msg, repo, deps, state.step);
      }
      return;
    }
  }
}

// ── debt-флоу: контекст и выполнение эффектов ──
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

// ── loan-флоу («Долги людям»): контекст и выполнение эффектов ──
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

// ── fx-флоу («Курсы»): контекст и выполнение эффектов ──
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

// ── реестр флоу ──

export const PF_FLOW: Flow<PfState, PfEffect, PfCtx> = {
  steps: PF_STEPS,
  textSteps: PF_TEXT_STEPS,
  ctx: (repo, p, deps) => pfCtx(repo, p, deps),
  inputCtx: (repo, p) => pfCtx(repo, p),
  advance: advancePf,
  render: renderPf,
  cancelTarget,
  runEffects: runPfEffects,
};

export const DEBT_FLOW: Flow<DebtState, DebtEffect, Awaited<ReturnType<typeof debtCtx>>> = {
  steps: DEBT_STEPS,
  textSteps: DEBT_TEXT_STEPS,
  screens: DEBT_SCREENS,
  cbPrefix: 'dbt:',
  ctx: debtCtx,
  inputCtx: debtCtx,
  advance: advanceDebt,
  render: renderDebt,
  cancelTarget: debtCancelTarget,
  runEffects: runDebtEffects,
};

export const LOAN_FLOW: Flow<LoanState, LoanEffect, Awaited<ReturnType<typeof loanCtx>>> = {
  steps: LOAN_STEPS,
  textSteps: LOAN_TEXT_STEPS,
  screens: LOAN_SCREENS,
  cbPrefix: 'ln:',
  ctx: loanCtx,
  inputCtx: loanCtx,
  advance: advanceLoan,
  render: renderLoan,
  cancelTarget: loanCancelTarget,
  runEffects: runLoanEffects,
};

export const FX_FLOW: Flow<FxState, FxEffect, Awaited<ReturnType<typeof fxCtx>>> = {
  steps: FX_STEPS,
  textSteps: FX_TEXT_STEPS,
  screens: FX_SCREENS,
  cbPrefix: 'fxa:',
  ctx: fxCtx,
  inputCtx: fxCtx,
  advance: advanceFx,
  render: renderFx,
  cancelTarget: fxCancelTarget,
  runEffects: runFxEffects,
};

/** Мастера с собственными экранами и callback-префиксом (кредиты, займы, обмены). */
export const WIZARD_FLOWS: readonly AnyFlow[] = [DEBT_FLOW, LOAN_FLOW, FX_FLOW];
/** Все флоу; реестры шагов не пересекаются (test/flows.test.ts). */
export const FLOWS: readonly AnyFlow[] = [PF_FLOW, ...WIZARD_FLOWS];

/** Флоу, которому принадлежит шаг диалога (undefined — шаг не из флоу). */
export const flowOfStep = (step: string): AnyFlow | undefined => FLOWS.find((f) => step in f.steps);
