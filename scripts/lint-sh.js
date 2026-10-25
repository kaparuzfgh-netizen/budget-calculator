#!/usr/bin/env node
/**
 * lint-sh.js — опциональный прогон shellcheck по sh-скриптам и хукам.
 * Если shellcheck не установлен — сообщает и выходит с кодом 0.
 * Запуск: npm run lint:sh
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function has(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

const files = [];
const scriptsDir = path.join(root, 'scripts');
for (const f of fs.readdirSync(scriptsDir)) {
  if (f.endsWith('.sh')) files.push(path.join('scripts', f));
}
const hook = path.join('scripts', 'hooks', 'pre-commit');
if (fs.existsSync(path.join(root, hook))) files.push(hook);

if (!files.length) {
  console.log('ℹ️  sh-скриптов нет — нечего проверять');
  process.exit(0);
}
if (!has('shellcheck')) {
  console.log('ℹ️  shellcheck не установлен — пропуск (файлы: ' + files.join(', ') + ')');
  process.exit(0);
}
try {
  execFileSync('shellcheck', files, { cwd: root, stdio: 'inherit' });
  console.log('✅ shellcheck: чисто (' + files.length + ' файлов)');
} catch (_) {
  process.exit(1);
}
