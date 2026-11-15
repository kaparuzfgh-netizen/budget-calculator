/**
 * theme.ts — тема Mini App: 'dark' | 'light'. Выбор пользователя —
 * localStorage 'bc.theme'; без него — по Telegram colorScheme (и
 * следование theme_changed, пока явного выбора нет).
 *
 * Применение — класс html.light: вся палитра на CSS-переменных
 * (index.css), перерендер не нужен; хром вебвью — applyChrome.
 */
import { applyChrome } from './tg';

export type Theme = 'dark' | 'light';
const KEY = 'bc.theme';

/** Сохранённый выбор; null — пользователь не выбирал (следуем Telegram). */
export function savedTheme(): Theme | null {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** Эффективная тема: сохранённая ?? Telegram colorScheme ?? тёмная. */
export function getTheme(): Theme {
  return savedTheme() ?? window.Telegram?.WebApp?.colorScheme ?? 'dark';
}

/** Класс на <html> — флипает все var(--color-*). */
export function applyThemeClass(t: Theme): void {
  document.documentElement.classList.toggle('light', t === 'light');
}

/** Применить тему сейчас: html-класс + хром вебвью (без сохранения). */
export function applyNow(t: Theme): void {
  applyThemeClass(t);
  const wa = window.Telegram?.WebApp;
  if (wa) applyChrome(wa, t);
}

/** Выбор пользователя: сохранить + применить. */
export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyNow(t);
}

/**
 * Boot: применить тему до первого рендера; без явного выбора —
 * следовать смене темы Telegram на лету.
 */
export function initTheme(): void {
  applyNow(getTheme());
  window.Telegram?.WebApp?.onEvent?.('theme_changed', () => {
    if (savedTheme() === null) applyNow(getTheme());
  });
}
