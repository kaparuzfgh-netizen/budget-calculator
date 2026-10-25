#!/usr/bin/env node
/**
 * install-hooks.js — копирует scripts/hooks/pre-commit в .git/hooks/.
 * Вызывается автоматически (`npm install` → prepare). Без .git (CI, архив) —
 * тихо пропускает. Никогда не падает с ненулевым кодом.
 * Ручной запуск: npm run prepare  (или bash scripts/install-hooks.sh)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'scripts', 'hooks', 'pre-commit');
const hooksDir = path.join(root, '.git', 'hooks');

try {
  if (!fs.existsSync(path.join(root, '.git'))) {
    console.log('ℹ️  .git не найден (CI/архив) — pre-commit хук не устанавливается');
    process.exit(0);
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(src, path.join(hooksDir, 'pre-commit'));
  try {
    fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
  } catch (_) {
    /* Windows: chmod не нужен */
  }
  console.log('✅ pre-commit хук установлен (.git/hooks/pre-commit)');
} catch (e) {
  console.warn('⚠️  не удалось установить pre-commit хук: ' + e.message);
}
process.exit(0);
