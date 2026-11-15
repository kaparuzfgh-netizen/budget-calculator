/**
 * env.mjs — мини-загрузчик .env для скриптов (без зависимостей).
 * Заполняет ТОЛЬКО отсутствующие ключи — явные переменные окружения важнее.
 * Файл .env не коммитится (gitignore); его отсутствие — не ошибка.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2'); // снимаем кавычки
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
