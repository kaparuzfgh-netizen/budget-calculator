/**
 * tg.ts — минимальные типы Telegram WebApp (отдельного пакета нет,
 * скрипт telegram-web-app.js грузится в index.html до бандла)
 * и инициализация вебвью: header/фон Telegram под тему приложения
 * + ready()/expand(). Тема — см. theme.ts.
 */
import type { Theme } from './theme';

export interface TelegramWebApp {
  initData: string;
  themeParams: Record<string, string>;
  /** Тема самого Telegram ('light'|'dark') — дефолт для нашей темы. */
  colorScheme?: Theme;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  /** Подписка на события WebApp (нам нужен theme_changed). */
  onEvent?(event: 'theme_changed', cb: () => void): void;
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

/** Фон приложения по темам — тёмная slate-950, светлая slate-50. */
const APP_BG: Record<Theme, string> = { dark: '#020617', light: '#f8fafc' };

/** Хром вебвью (header + фон за пределами приложения) под тему. */
export function applyChrome(wa: TelegramWebApp, theme: Theme): void {
  const bg = APP_BG[theme];
  wa.setHeaderColor?.(bg);
  wa.setBackgroundColor?.(bg);
}

/** Boot: хром под тему + ready/expand. */
export function applyTheme(wa: TelegramWebApp, theme: Theme): void {
  applyChrome(wa, theme);
  wa.ready();
  wa.expand();
}
