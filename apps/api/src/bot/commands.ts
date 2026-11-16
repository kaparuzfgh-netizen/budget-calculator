/**
 * commands.ts — тексты и ответы бота (все сообщения по-русски).
 * Вся логика доступа — в services/access.ts; здесь только формирование ответов.
 */
import { escapeHtml } from '../telegram/client';
import type { UserRow } from '../db/repo';

export const TEXT = {
  welcome: (name: string | null) =>
    `Привет${name ? `, <b>${escapeHtml(name)}</b>` : ''}! Это «Бюджет-компаньон» — ` +
    'личный трекер финансов. Начинаем короткую настройку.',
  welcomeOwner: (name: string | null) =>
    `Привет${name ? `, <b>${escapeHtml(name)}</b>` : ''}! Ты зарегистрирован как <b>владелец</b>. ` +
    'Начинаем короткую настройку.',
  help: (role: 'owner' | 'member') =>
    'Доступные команды:\n' +
    '/start — настройка профиля\n' +
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
    'Сейчас короткая настройка:',
  myId: (tgId: number) => `Твой Telegram ID: <code>${tgId}</code>`,
  helpOnboarded: () =>
    'Команды:\n/plan [сумма [валюта]] — план месяца (водопад)\n' +
    '/spent сумма [валюта] [заметка] — записать трату\n' +
    '/income сумма [валюта] [заметка] — факт дохода за месяц\n' +
    '/week — неделя и месяц расходов\n' +
    '/report — отчёт за период (неделя…год)\n' +
    '/credits — кредиты и ипотеки\n' +
    '/loans — долги людям\n' +
    '/fx — курсы: выгодно ли менять + журнал обменов\n' +
    '/family — общий бюджет на двоих\n' +
    '/profile — профиль: разделы, правки платежей\n' +
    '/menu — главное меню\n' +
    '/id — твой Telegram ID\n' +
    'Просто напишите сумму: «500 кафе» — запишется трата.\n' +
    'Категории — в приложении.\n' +
    'Навигация — inline-кнопки и /menu.',
  unknownCommand: 'Не знаю такую команду — попробуй /help.',
  // ── общий бюджет пары ──
  familyInvite: (link: string | null, code: string) =>
    'Общий бюджет создан. Перешли партнёру ссылку — он станет вторым участником:\n' +
    (link ? link : `/start ${escapeHtml(code)}`) +
    '\n\nКод одноразовый и действует 48 часов.',
  familyAlready: 'Вы уже в общем бюджете. /family — статус, /family leave — выйти.',
  familyJoined: (name: string | null) =>
    `Вы в общем бюджете${name ? ` с ${escapeHtml(name)}` : ''}! ` +
    'Общий недельный лимит — в приложении («Обзор» → «Общий бюджет») и в /family.',
  familyJoinedPartner: (name: string | null) =>
    `${name ? `<b>${escapeHtml(name)}</b>` : 'Партнёр'} присоединился к вашему общему бюджету.`,
  familyLeft: 'Вы вышли из общего бюджета — личный недельный бюджет остаётся.',
  familyLeftPartner: (name: string | null) =>
    `${name ? `<b>${escapeHtml(name)}</b>` : 'Партнёр'} вышел из общего бюджета — он удалён.`,
  familyStatus: (line: string, cap: string) =>
    `Общий бюджет недели: ${line}.\nМесячный лимит: ${cap} — правится в приложении (профиль → «Семья»).`,
  familyNoPair: 'Общего бюджета нет. /family — создать и получить ссылку-приглашение.',
  familyInvalid: 'Приглашение недействительно, истекло или место занято.',
};

export const INVITE_TTL_MS = 48 * 3600 * 1000;
export const MAX_ACTIVE_INVITES = 10;

/** Ссылка t.me или текст-команда — зависит от настроенного username бота. */
export function inviteLink(code: string, botUsername: string | undefined): string | null {
  const u = (botUsername ?? '').trim();
  return u ? `https://t.me/${u}?start=${code}` : null;
}

export type { UserRow };
