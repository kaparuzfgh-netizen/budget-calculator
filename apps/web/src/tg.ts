/**
 * tg.ts — минимальные типы Telegram WebApp (отдельного пакета нет,
 * скрипт telegram-web-app.js грузится в index.html до бандла)
 * и применение тёмной темы из themeParams → CSS-переменные.
 */

export interface TelegramWebApp {
  initData: string;
  themeParams: Record<string, string>;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** themeParams → --tg-theme-* (фолбэки уже заданы в index.html). */
export function applyTheme(wa: TelegramWebApp): void {
  const tp = wa.themeParams ?? {};
  for (const [k, v] of Object.entries(tp)) {
    if (v) document.documentElement.style.setProperty(`--tg-theme-${k.replace(/_/g, '-')}`, v);
  }
  wa.setHeaderColor?.(tp.bg_color ?? '#17212b');
  wa.setBackgroundColor?.(tp.bg_color ?? '#17212b');
  wa.ready();
  wa.expand();
}
