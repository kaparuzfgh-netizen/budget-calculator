/**
 * access.ts — контур допуска бота (ADR-0001, аудит S4/S5):
 *   владелец → авто-бутстрап по OWNER_TELEGRAM_ID;
 *   незнакомец + /start <код> → одноразовый инвайт;
 *   незнакомец без кода → тишина (никаких ответов и записей о нём);
 *   известный пользователь → команды /start /help /invite /id.
 *
 * Никогда не логируем текст сообщений, токены, коды приглашений и их хэши.
 */
import { accessRepo, type UserRow } from '../db/repo';
import type { TelegramClient } from '../telegram/client';
import { INVITE_TTL_MS, MAX_ACTIVE_INVITES, TEXT, inviteLink } from '../bot/commands';

export interface IncomingMessage {
  chatId: number;
  fromId: number;
  firstName: string | null;
  text: string;
}

export interface AccessDeps {
  db: D1Database;
  telegram: TelegramClient;
  ownerTelegramId?: string | undefined;
  botUsername?: string | undefined;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Одноразовый код: 16 случайных байт → base64url (в БД уходит только хэш). */
function newInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const CMD = (name: string) => new RegExp(`^/${name}(?:@\\w+)?$`);
const START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?$/;

/** Главный обработчик входящего личного сообщения. */
export async function handleMessage(msg: IncomingMessage, deps: AccessDeps): Promise<void> {
  const repo = accessRepo(deps.db);
  const tg = deps.telegram;
  const send = (text: string) => tg.sendMessage(msg.chatId, text);
  const user = await repo.findUserByTelegramId(msg.fromId);
  const ownerId = (deps.ownerTelegramId ?? '').trim();
  const ownerSet = ownerId !== '' && /^\d+$/.test(ownerId);

  if (!user) {
    // Авто-бутстрап владельца — любой текст при настроенном OWNER_TELEGRAM_ID.
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
    // /id при ненастроенном владельце — безопасный путь узнать свой ID,
    // отвечаем один раз на telegram_id (гейт — audit_log).
    if (CMD('id').test(msg.text.trim()) && !ownerSet) {
      if (!(await repo.idReplySent(msg.fromId))) {
        await repo.audit('id_reply', null, { tg: msg.fromId });
        await send(TEXT.myId(msg.fromId));
      }
      return;
    }
    return; // незнакомец без кода — тишина, ноль записей в БД
  }

  // ── известный активный пользователь ──
  const text = msg.text.trim();
  if (START_RE.test(text)) {
    await send(user.role === 'owner' ? TEXT.welcomeOwner(user.display_name) : TEXT.welcome(user.display_name));
    return;
  }
  if (CMD('id').test(text)) {
    await send(TEXT.myId(msg.fromId));
    return;
  }
  if (CMD('invite').test(text)) {
    await createInvite(msg, user, deps, repo);
    return;
  }
  if (CMD('help').test(text)) {
    await send(TEXT.help(user.role));
    return;
  }
  await send(TEXT.unknownCommand);
}

/** /invite — только владелец; в БД — только SHA-256 кода. */
async function createInvite(msg: IncomingMessage, user: UserRow, deps: AccessDeps, repo: ReturnType<typeof accessRepo>) {
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
  // В аудит — только срок; ни код, ни хэш не логируем.
  await repo.audit('invite_created', user.id, { expires_at: expiresAt });
  await tg.sendMessage(msg.chatId, TEXT.inviteCreated(inviteLink(code, deps.botUsername), code));
}

/**
 * /start <код> от незнакомца. Создаём пользователя, затем атомарно помечаем
 * инвайт использованным условным UPDATE'ом (см. repo.redeemInvite): при гонке
 * двух sender'ов выиграет ровно один; проигравшему удаляем свежую строку
 * пользователя — полу-созданного пользователя не остаётся.
 */
async function redeemInvite(
  msg: IncomingMessage,
  code: string,
  deps: AccessDeps,
  repo: ReturnType<typeof accessRepo>,
) {
  const tg = deps.telegram;
  const codeHash = await sha256Hex(code);
  // Пачка атомарна: при SQLITE single-writer конфликте вся она откатывается
  // целиком (пользователь не остаётся) — безопасно ретраим «database is locked».
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
  const reason = await repo.inviteState(codeHash); // только для аудита
  await repo.audit('invite_redeem_failed', null, { reason });
  await tg.sendMessage(msg.chatId, TEXT.inviteInvalid);
}
