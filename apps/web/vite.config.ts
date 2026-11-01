/**
 * vite.config.ts — сборка Mini App.
 * @tailwindcss/vite: Tailwind v4 — единый стиль приложения (src/index.css,
 * импортируется из main.tsx).
 */
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  // фиксированный порт для локального предпросмотра — не прыгает на
  // свободный при занятости, а падает с явной ошибкой
  server: { port: 5174, strictPort: true },
});
