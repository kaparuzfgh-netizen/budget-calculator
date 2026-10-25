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
import type { TelegramClient } from '../telegram/client';
import { INVITE_TTL_MS, MAX_ACTIVE_INVITES, TEXT, inviteLink } from '../bot/commands';
import {
  advance,
  onCcyResult,
  startOnboarding,
  MAIN_MENU,
  type ObEffect,
  type ObInput,
  type ObState,
} from '../bot/onboarding';
import { parseAmount, todayInTz } from '../bot/parse';
import { runPlan, runProfile, runSpent, runWeek } from '../bot/features';
import type { FxProvider } from '../fx/provider';
import { getFxRates } from '../fx/service';

export interface IncomingMessage {
  chatId: number;
  fromId: number;
  firstName: string | null;
  text: string;
  updateId: number;
}

export interface AccessDeps {
  db: D1Database;
  telegram: TelegramClient;
  ownerTelegramId?: string | undefined;
  botUsername?: string | undefined;
  fx?: FxProvider;
  now?: Date;
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
  '⚙️ Профиль': '/profile',
};
const STALE_MS = 24 * 3600 * 1000;

const fxAdapter = (deps: AccessDeps) => ({
  get: (ccys: string[]) => getFxRates(deps.db, deps.fx!, ccys, deps.now ?? new Date()),
});

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

/** Текущее состояние диалога (или запуск). Старше 24ч → перезапуск. */
async function currentOb(
  repo: ReturnType<typeof scoped>,
  deps: AccessDeps,
): Promise<{ state: ObState | null; effects: ObEffect[] } | null> {
  const conv = await repo.getConversation();
  if (!conv) return null;
  const now = deps.now ?? new Date();
  if (now.getTime() - Date.parse(conv.updated_at) > STALE_MS) {
    return startOnboarding(); // устарело — вежливый рестарт с шага 1
  }
  return { state: { step: conv.step as ObState['step'], data: JSON.parse(conv.data) as ObState['data'] }, effects: [] };
}

/** Точка входа для известного пользователя: онбординг или команды. */
async function knownUser(msg: IncomingMessage, user: UserRow, deps: AccessDeps): Promise<void> {
  const tg = deps.telegram;
  const repo = scoped(deps.db, user.id);
  const profile = await repo.getProfile();
  const text = msg.text.trim();

  // Активный диалог онбординга — любой ввод туда (кроме /cancel — внутри редьюсера).
  const conv = await currentOb(repo, deps);

  // /cancel — всегда, в одном месте, никогда не проваливается в unknownCommand.
  if (/^\/cancel(?:@\w+)?\s*$/.test(text)) {
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
    if ((conv.state!.step as string) === 'spent_ask') {
      // «➕ Трата» ждала сумму: команда/кнопка меню — отменяем вопрос и идём к ней,
      // сумма — записываем, мусор — ошибка, вопрос остаётся активным.
      if (!text.startsWith('/') && !MENU[text]) {
        try {
          parseAmount(text);
        } catch (e) {
          await tg.sendMessage(msg.chatId, (e as Error).message);
          return;
        }
        await repo.clearConversation();
        await runSpent(
          msg.chatId,
          tg,
          repo,
          fxAdapter(deps),
          text,
          `tg:${msg.updateId}`,
          todayInTz(profile?.timezone ?? 'UTC', deps.now ?? new Date()),
        );
        return;
      }
      await repo.clearConversation();
      // проваливаемся к обычной диспетчеризации команды
    } else {
      await applyOnboarding(advance(conv.state!, { type: 'text', text }), msg, user, deps, conv.state!.step);
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
  if (START_RE.test(cmd)) {
    await tg.sendMessage(msg.chatId, 'Ты уже настроен — команды в /help', { replyMarkup: MAIN_MENU });
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
  if (CMD('spent').test(cmd)) {
    const arg = cmd.split(/\s+/).slice(1).join(' ').trim();
    if (arg) {
      await runSpent(msg.chatId, tg, repo, fx, arg, `tg:${msg.updateId}`, today);
      return;
    }
    await repo.setConversation('spent_ask', '{}');
    await tg.sendMessage(msg.chatId, 'Сколько потратили? (например: 320 или 320 kgs кофе)');
    return;
  }
  if (CMD('profile').test(cmd)) {
    await runProfile(msg.chatId, tg, repo);
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
  // не команда — пробуем как сумму траты («3200 kgs кофе»)
  try {
    parseAmountCheck(text);
    await runSpent(msg.chatId, tg, repo, fx, text, `tg:${msg.updateId}`, today);
    return;
  } catch {
    await tg.sendMessage(msg.chatId, TEXT.unknownCommand);
  }
}

function parseAmountCheck(text: string): void {
  // только гейт: быстрый отсев некомандного текста (runSpent перепарсит)
  if (!/^\d/.test(text.trim())) throw new Error('not an amount');
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
      await repo.audit('owner_bootstrap', Number(r.meta.last_row_id));
      await send(TEXT.welcomeOwner(msg.firstName));
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
  cb: { id: string; chatId: number; fromId: number; firstName: string | null; data: string },
  deps: AccessDeps,
): Promise<void> {
  const repo = accessRepo(deps.db);
  const user = await repo.findUserByTelegramId(cb.fromId);
  await deps.telegram.answerCallbackQuery(cb.id);
  if (!user) return; // незнакомец — молча
  const r = scoped(deps.db, user.id);
  const msg: IncomingMessage = { chatId: cb.chatId, fromId: cb.fromId, firstName: cb.firstName, text: '', updateId: 0 };

  if (cb.data === 'ob:reset') {
    const start = startOnboarding();
    await applyOnboarding(start, msg, user, deps);
    return;
  }
  const conv = await currentOb(r, deps);
  if (!conv?.state) return;
  const input: ObInput = { type: 'callback', data: cb.data };
  await applyOnboarding(advance(conv.state, input), msg, user, deps, conv.state.step);
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
    await tg.sendMessage(msg.chatId, TEXT.joined(msg.firstName));
    return;
  }
  const reason = await repo.inviteState(codeHash);
  await repo.audit('invite_redeem_failed', null, { reason });
  await tg.sendMessage(msg.chatId, TEXT.inviteInvalid);
}
