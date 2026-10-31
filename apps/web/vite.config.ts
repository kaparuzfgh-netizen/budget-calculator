/**
 * vite.config.ts — сборка Mini App.
 * @tailwindcss/vite: Tailwind v4 — единый стиль приложения (src/index.css,
 * импортируется из main.tsx).
 */
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
});
