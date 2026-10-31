/**
 * tg.ts — минимальные типы Telegram WebApp (отдельного пакета нет,
 * скрипт telegram-web-app.js грузится в index.html до бандла)
 * и инициализация вебвью: фиксированная тёмная тема приложения
 * (slate-950), header/фон Telegram под неё + ready()/expand().
 */

export interface TelegramWebApp {
  initData: string;
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  /** Системная кнопка «Назад» Telegram (Bot API ≥ 6.1). */
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** Фон приложения — slate-950 (#020617), как у дизайн-прототипа tw.tsx. */
const APP_BG = '#020617';

/**
 * Хром Telegram под цвета приложения + ready/expand.
 * themeParams в CSS-переменные больше не разводим — тема фиксированная.
 */
export function applyTheme(wa: TelegramWebApp): void {
  wa.setHeaderColor?.(APP_BG);
  wa.setBackgroundColor?.(APP_BG);
  wa.ready();
  wa.expand();
}
