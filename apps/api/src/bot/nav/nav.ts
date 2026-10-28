/**
 * nav.ts — единая навигация бота (docs/ux/navigation.md, R1–R9).
 * Реестр — screens.json; рендеры НЕ строят назад/меню руками — row() добавляет.
 */
import { z } from 'zod';
import type { InlineButton, ReplyMarkup } from '../../telegram/client';
import screensJson from './screens.json';

const screenSchema = z.object({
  id: z.string(),
  kind: z.enum(['root', 'menu', 'prompt', 'confirm', 'result']),
  depth: z.number(),
  parent: z.string().nullable(),
  nav: z.enum(['reply', 'home', 'back_home', 'cancel', 'confirm']),
  altParent: z.string().optional(),
});
const registrySchema = z.object({
  screens: z.array(screenSchema),
  edges: z.array(z.tuple([z.string(), z.string()])),
});
export const REGISTRY = registrySchema.parse(screensJson);
export type Screen = z.infer<typeof screenSchema>;
const BY_ID = new Map(REGISTRY.screens.map((s) => [s.id, s]));

export function getScreen(id: string): Screen | undefined {
  return BY_ID.get(id);
}

export const NAV_HOME = 'nv:home';
export const navBack = (to: string) => `nv:back:${to}`;
export const navGo = (to: string) => `nv:go:${to}`;

const HOME_BTN: InlineButton = { text: '🏠 Меню', callback_data: NAV_HOME };
const backBtn = (to: string): InlineButton => ({ text: '← Назад', callback_data: navBack(to) });
export const cancelBtn = (to: string): InlineButton => ({ text: '✖ Отмена', callback_data: navBack(to) });
export const HOME_ROW: InlineButton[] = [HOME_BTN];

/**
 * Обязательный навигационный ряд экрана по реестру (R1–R4):
 *   home → [🏠 Меню]; back_home → [← Назад][🏠 Меню]; cancel → [✖ Отмена]→parent;
 *   confirm → [Да][✖ Отмена] (Да кладёт экран отдельно); reply → без inline-ряда.
 * `backTo` — переопределяет parent (например INCOME_HUB, открытый из профиля).
 */
export function navRow(screenId: string, backTo?: string): InlineButton[] | null {
  const s = BY_ID.get(screenId);
  if (!s) return null;
  const target = backTo ?? s.parent ?? 'HOME';
  if (backTo && backTo !== s.parent) return [backBtn(backTo), HOME_BTN]; // altParent (R-спец)
  switch (s.nav) {
    case 'reply':
      return null;
    case 'home':
      return [HOME_BTN];
    case 'back_home':
      return [backBtn(target), HOME_BTN];
    case 'cancel':
      return [cancelBtn(target)];
    case 'confirm':
      return [cancelBtn(target)]; // «Да» добавляет сам экран
  }
}

/**
 * HOME — экран «Главное меню» (R5): пункты бывшей нижней клавиатуры как
 * inline-кнопки. Нижняя reply-клавиатура из контракта убрана — навигация
 * через /menu, 🏠 Меню и эти кнопки.
 * Mini App запускается голубой menu-button у поля ввода (setChatMenuButton
 * web_app — ставится в scripts/setup.mjs), inline-кнопки «Приложение» нет.
 */
export function homeMarkup(): ReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📊 План', callback_data: navGo('PLAN') },
        { text: '📅 Неделя', callback_data: navGo('WEEK') },
      ],
      [
        { text: '➕ Трата', callback_data: navGo('SPENT_ASK') },
        { text: '💵 Доход', callback_data: navGo('INCOME_HUB') },
      ],
      [
        { text: '🏦 Кредиты', callback_data: navGo('DEBTS') },
        { text: '🤝 Долги', callback_data: navGo('LOANS') },
      ],
      [{ text: '⚙️ Профиль', callback_data: navGo('PF_HOME') }],
    ],
  };
}

/** Добавить нав-ряд к reply_markup (если его ещё нет). */
export function withNav(screenId: string, markup?: ReplyMarkup, backTo?: string): ReplyMarkup | undefined {
  const row = navRow(screenId, backTo);
  if (!row) return markup;
  const rows = markup?.inline_keyboard ?? [];
  // не дублируем, если ряд уже содержит 🏠/✖/←
  if (rows.some((r) => r.some((b) => /^(nv:home|nv:back:)/.test(b.callback_data ?? '')))) return markup;
  return { ...(markup ?? {}), inline_keyboard: [...rows, row] };
}
