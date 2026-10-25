/**
 * commands.ts — тексты и ответы бота (все сообщения по-русски).
 * Вся логика доступа — в services/access.ts; здесь только формирование ответов.
 */
import { escapeHtml } from '../telegram/client';
import type { UserRow } from '../db/repo';

export const TEXT = {
  welcome: (name: string | null) =>
    `Привет${name ? `, <b>${escapeHtml(name)}</b>` : ''}! Это «Бюджет-компаньон» — ` +
    'личный трекер финансов. Онбординг появится в следующем релизе — пока посмотри /help.',
  welcomeOwner: (name: string | null) =>
    `Привет${name ? `, <b>${escapeHtml(name)}</b>` : ''}! Ты зарегистрирован как <b>владелец</b>. ` +
    'Онбординг появится в следующем релизе — пока посмотри /help.',
  help: (role: 'owner' | 'member') =>
    'Доступные команды:\n' +
    '/start — приветствие\n' +
    '/help — этот список\n' +
    '/id — твой Telegram ID' +
    (role === 'owner' ? '\n/invite — создать одноразовое приглашение' : ''),
  inviteCreated: (link: string | null, code: string) =>
    (link ? `Ссылка-приглашение:\n${link}` : `Отправь новому участнику:\n/start ${escapeHtml(code)}`) +
    '\n\nКод одноразовый и действует 48 часов.',
  inviteLimit: 'Достигнут лимит активных приглашений (10). Дождись их использования или истечения.',
  inviteForbidden: 'Команда /invite доступна только владельцу.',
  inviteInvalid: 'Приглашение недействительно или истекло. Попроси новое.',
  joined: (name: string | null) =>
    `Привет${name ? `, <b>${escapeHtml(name)}</b>` : ''}! Приглашение принято — ты участник. ` +
    'Онбординг появится в следующем релизе — пока посмотри /help.',
  myId: (tgId: number) => `Твой Telegram ID: <code>${tgId}</code>`,
  helpOnboarded: () =>
    'Команды:\n/plan [сумма [валюта]] — план месяца (водопад)\n' +
    '/spent <сумма> [валюта] [заметка] — записать трату\n' +
    '/week — неделя и месяц расходов\n' +
    '/profile — профиль и платежи\n' +
    '/id — твой Telegram ID\n' +
    'Кнопки-меню внизу чата.',
  unknownCommand: 'Не знаю такую команду — попробуй /help.',
};

export const INVITE_TTL_MS = 48 * 3600 * 1000;
export const MAX_ACTIVE_INVITES = 10;

/** Ссылка t.me или текст-команда — зависит от настроенного username бота. */
export function inviteLink(code: string, botUsername: string | undefined): string | null {
  const u = (botUsername ?? '').trim();
  return u ? `https://t.me/${u}?start=${code}` : null;
}

export type { UserRow };
