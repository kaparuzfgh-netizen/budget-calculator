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
import { monthInTz, parseAmount, todayInTz } from '../bot/parse';
import { runInvest } from '../bot/invest';
import { handleExCategory, runIncome, runPlan, runProfile, runReport, runSpent, runWeek } from '../bot/features';
import { householdLine, householdSummary } from './household';
import { fmtMoney } from '../bot/format';
import type { Period } from '../domain/report';
import { advancePf, renderPf, type PfState } from '../bot/profile';
import {
  applyFlow,
  cancelFlow,
  DEBT_FLOW,
  flowOfStep,
  FX_FLOW,
  fxAdapter,
  LOAN_FLOW,
  openHub,
  PF_FLOW,
  pfCtx,
  showScreen,
  WIZARD_FLOWS,
  type FlowState,
} from './flows';
import { getScreen, homeMarkup, NAV_HOME } from '../bot/nav/nav';
import type { FxProvider } from '../fx/provider';
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
  '💼 Инвестиции': '/invest',
  '📈 Отчёт': '/report',
  '⚙️ Профиль': '/profile',
};
const STALE_MS = 24 * 3600 * 1000;

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
      const flow = WIZARD_FLOWS.find((fl) => (conv.state!.step as string) in fl.steps) ?? PF_FLOW;
      await cancelFlow(flow, conv.state as FlowState, msg.chatId, repo, deps, profile);
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

  // /start для не-онбоарденного — всегда (пере)запуск мастера с шага 1:
  // застрял посреди визарда или только что принял приглашение — начинаем чисто.
  if (!profile?.onboarded_at && START_RE.test(text)) {
    await applyOnboarding(startOnboarding(), msg, user, deps);
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
              await showScreen(PF_FLOW, 'INCOME_HUB', conv.state!.data ?? {}, msg.chatId, repo, deps, p0);
            }
          }
        }
        return;
      }
      await repo.clearConversation();
      // проваливаемся к обычной диспетчеризации команды
    } else if (flowOfStep(step)) {
      const flow = flowOfStep(step)!;
      if (!text.startsWith('/') && !MENU[text]) {
        if (flow.textSteps.has(step)) {
          // текст — ввод для шага мастера
          const p0 = await repo.getProfile();
          if (!p0) {
            await repo.clearConversation();
            return;
          }
          const ctx = await flow.inputCtx(repo, p0, deps);
          await applyFlow(flow, flow.advance(conv.state as FlowState, { type: 'text', text }, ctx), msg, repo, deps, step);
          return;
        }
        // навигационный экран: произвольный текст — не команда и не ввод,
        // состояние (кнопки экрана) сохраняем
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
    } else if (!text.startsWith('/')) {
      await applyOnboarding(advance(conv.state!, { type: 'text', text }), msg, user, deps, step);
      return;
    }
    // онбординг-шаги: slash-команды редьюсеру не скармливаем — /help, /id,
    // /invite обязаны работать посреди мастера; состояние сохраняется.
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
  // /start hh_<код> — вход в общий бюджет по ссылке (известный юзер)
  const hhCode = START_RE.exec(cmd)?.[1];
  if (hhCode?.startsWith('hh_')) {
    await joinHouseholdCmd(msg, user, hhCode.slice(3), deps);
    return;
  }
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
    await applyFlow(
      PF_FLOW,
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
      await showScreen(PF_FLOW, 'PF_DELETE_ASK', {}, msg.chatId, repo, deps, p0);
    }
    return;
  }
  if (CMD('expenses').test(cmd)) {
    const p0 = await repo.getProfile();
    if (p0) {
      await showScreen(PF_FLOW, 'EXPENSES_LIST', {}, msg.chatId, repo, deps, p0);
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
          await showScreen(PF_FLOW, 'INCOME_HUB', {}, msg.chatId, repo, deps, p0);
        }
      }
      return;
    }
    // /income без аргументов → экран INCOME_HUB (итог + кнопки)
    const p0 = await repo.getProfile();
    if (p0) {
      await showScreen(PF_FLOW, 'INCOME_HUB', {}, msg.chatId, repo, deps, p0);
      return;
    }
    await repo.setConversation('income_ask', '{}');
    const r0 = renderPf('INCOME_ASK', {}, await pfCtx(repo, (await repo.getProfile())!, deps));
    await tg.sendMessage(msg.chatId, r0.text, r0.markup ? { replyMarkup: r0.markup } : {});
    return;
  }
  if (CMD('credits').test(cmd) || CMD('debts').test(cmd)) {
    await openHub(DEBT_FLOW, 'DEBTS', msg, repo, deps);
    return;
  }
  if (CMD('loans').test(cmd)) {
    await openHub(LOAN_FLOW, 'LOANS', msg, repo, deps);
    return;
  }
  if (CMD('invest').test(cmd)) {
    await runInvest(msg.chatId, tg, repo, fx, today);
    return;
  }
  if (CMD('fx').test(cmd)) {
    await openHub(FX_FLOW, 'FX_HUB', msg, repo, deps);
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
  if (CMD('family').test(cmd)) {
    await familyCmd(msg, user, deps);
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
      const created = await repo.findUserByTelegramId(msg.fromId);
      if (created) await applyOnboarding(startOnboarding(), msg, created, { ...deps, telegram: stg });
      return;
    }
    const m = START_RE.exec(msg.text);
    const code = m?.[1];
    if (code) {
      // hh_<код> — инвайт в общий бюджет пары (создаёт юзера + членство)
      if (code.startsWith('hh_')) {
        await redeemHouseholdNewUser(msg, code.slice(3), deps, repo);
        return;
      }
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
  await repo.refreshDisplayName(user, msg.firstName); // имя в TG меняется — refresh-on-change
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
  await repo.refreshDisplayName(user, cb.firstName);
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
      INVEST: '/invest',
      REPORT: '/report',
    }[target];
    if (cmd) {
      await knownUser({ ...navMsg, text: cmd }, user, deps);
      return;
    }
    // экраны мастеров — прямой рендер (id сущности — из состояния диалога);
    // остальные pf/income-экраны — через renderPf
    const flow = WIZARD_FLOWS.find((fl) => fl.screens?.has(target)) ?? PF_FLOW;
    const conv0 = await r.getConversation();
    const data = (conv0 ? (JSON.parse(conv0.data) as object) : {}) ?? {};
    await showScreen(flow, target, data, cb.chatId, r, deps, p0);
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
    if (!(step in PF_FLOW.steps)) return; // чужой шаг — молча
    const ctx = await pfCtx(r, p0);
    // без разговора CAS по шагу не сработает — применяем безусловно
    await applyFlow(
      PF_FLOW,
      advancePf(st as PfState, { type: 'callback', data: cb.data }, ctx),
      msg,
      r,
      deps,
      conv?.state ? step : undefined,
    );
    return;
  }
  const wizard = WIZARD_FLOWS.find((fl) => cb.data.startsWith(fl.cbPrefix!));
  if (wizard) {
    if (!p0?.onboarded_at || !conv) return; // без диалога кнопки мастеров мертвы
    if (!(step in wizard.steps)) return; // чужой шаг — молча
    const ctx = await wizard.inputCtx(r, p0, deps);
    await applyFlow(wizard, wizard.advance(st as FlowState, { type: 'callback', data: cb.data }, ctx), msg, r, deps, step);
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
    const created = await repo.findUserByTelegramId(msg.fromId);
    if (created) await applyOnboarding(startOnboarding(), msg, created, { ...deps, telegram: stg });
    return;
  }
  const reason = await repo.inviteState(codeHash);
  await repo.audit('invite_redeem_failed', null, { reason });
  await tg.sendMessage(msg.chatId, TEXT.inviteInvalid);
}

// ── общий бюджет пары (/family, hh_-инвайты) ──

/** /family: статус · создание пары+инвайта · /family leave — выход. */
async function familyCmd(msg: IncomingMessage, user: UserRow, deps: AccessDeps) {
  const tg = deps.telegram;
  const repo = accessRepo(deps.db);
  const existing = await repo.householdFor(user.id);

  if (/\bleave\b/.test(msg.text)) {
    if (!existing) {
      await tg.sendMessage(msg.chatId, TEXT.familyNoPair);
      return;
    }
    const members = await repo.householdMembers(existing.id);
    await repo.leaveHousehold(user.id);
    await repo.audit('household_left', user.id);
    await tg.sendMessage(msg.chatId, TEXT.familyLeft);
    const other = members.find((m) => m.user_id !== user.id);
    if (other) await tg.sendMessage(other.telegram_id, TEXT.familyLeftPartner(user.display_name));
    return;
  }

  if (!existing) {
    const now = new Date();
    if ((await repo.countActiveInvites(user.id, now.toISOString())) >= MAX_ACTIVE_INVITES) {
      await tg.sendMessage(msg.chatId, TEXT.inviteLimit);
      return;
    }
    // лимит по умолчанию — личный living_cap партнёра-создателя
    const prof = await scoped(deps.db, user.id).getProfile();
    const capMinor = prof?.living_cap_minor ?? 0;
    const ccy = prof?.living_currency ?? 'USD';
    const weeklyMinor = prof?.weekly_budget_minor ?? Math.round((capMinor * 12) / 52);
    const hhId = await repo.createHousehold(user.id, capMinor, ccy, weeklyMinor);
    const code = `hh_${newInviteCode()}`;
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    await repo.createHouseholdInvite(await sha256Hex(code), user.id, hhId, expiresAt);
    // хэш хранится от полного кода с префиксом 'hh_' (входы: бот/TMA — одинаково)
    await repo.audit('household_invite_created', user.id, { expires_at: expiresAt });
    await tg.sendMessage(msg.chatId, TEXT.familyInvite(inviteLink(code, deps.botUsername), code));
    return;
  }

  // статус: недельная строка «потрачено / лимит» + месячный лимит
  const fmt = (minor: number, ccy: string) => fmtMoney(minor / 100, ccy);
  try {
    const s = await householdSummary(deps.db, user.id, fxAdapter(deps).get, deps.now ?? new Date());
    if (!s) {
      await tg.sendMessage(msg.chatId, TEXT.familyNoPair);
      return;
    }
    await tg.sendMessage(msg.chatId, TEXT.familyStatus(householdLine(s, fmt), fmt(s.living_cap_minor, s.currency)));
  } catch {
    await tg.sendMessage(msg.chatId, TEXT.familyStatus(fmt(existing.weekly_budget_minor, existing.living_currency), fmt(existing.living_cap_minor, existing.living_currency)));
  }
}

/** /start hh_<код> у известного юзера — join в существующий household. */
async function joinHouseholdCmd(msg: IncomingMessage, user: UserRow, code: string, deps: AccessDeps) {
  const tg = deps.telegram;
  const repo = accessRepo(deps.db);
  if (await repo.householdFor(user.id)) {
    await tg.sendMessage(msg.chatId, TEXT.familyAlready);
    return;
  }
  const r = await repo.redeemHouseholdInvite(await sha256Hex(`hh_${code}`), user.id, new Date().toISOString());
  if (!r.redeemed) {
    await repo.audit('household_join_failed', user.id);
    await tg.sendMessage(msg.chatId, TEXT.familyInvalid);
    return;
  }
  await repo.audit('household_joined', user.id);
  const hh = await repo.householdFor(user.id);
  const members = hh ? await repo.householdMembers(hh.id) : [];
  const other = members.find((m) => m.user_id !== user.id);
  await tg.sendMessage(msg.chatId, TEXT.familyJoined(other?.display_name ?? null));
  if (other) await tg.sendMessage(other.telegram_id, TEXT.familyJoinedPartner(user.display_name));
}

/** /start hh_<код> у незнакомца — atomic: юзер + членство + погашение. */
async function redeemHouseholdNewUser(
  msg: IncomingMessage,
  code: string,
  deps: AccessDeps,
  repo: ReturnType<typeof accessRepo>,
) {
  const tg = deps.telegram;
  const codeHash = await sha256Hex(`hh_${code}`);
  let r: { redeemed: boolean; userId: number } | undefined;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    try {
      r = await repo.redeemHouseholdInviteNewUser(codeHash, msg.fromId, msg.firstName, new Date().toISOString());
    } catch (e) {
      if (!/locked|busy/i.test(String(e)) || attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 30 * (attempt + 1)));
    }
  }
  const res = r!;
  if (!res.redeemed) {
    await repo.audit('household_join_failed', null);
    await tg.sendMessage(msg.chatId, TEXT.familyInvalid);
    return;
  }
  await repo.audit('household_joined', res.userId);
  const created = await repo.findUserByTelegramId(msg.fromId);
  if (!created) return;
  const hh = await repo.householdFor(created.id);
  const members = hh ? await repo.householdMembers(hh.id) : [];
  const other = members.find((m) => m.user_id !== created.id);
  const stg = tgWithKeyboardMigration(scoped(deps.db, created.id), tg);
  await stg.sendMessage(msg.chatId, TEXT.familyJoined(other?.display_name ?? null));
  if (other) await tg.sendMessage(other.telegram_id, TEXT.familyJoinedPartner(msg.firstName));
  await applyOnboarding(startOnboarding(), msg, created, { ...deps, telegram: stg });
}
