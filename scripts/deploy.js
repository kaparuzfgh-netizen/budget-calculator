#!/usr/bin/env node
/**
 * deploy.js — полный цикл деплоя бэкенда в Apps Script через clasp:
 *
 *   npm run check → clasp push --force → create-version →
 *   update-deployment (если известен deploymentId) | create-deployment → URL
 *
 * deploymentId берётся из env DEPLOYMENT_ID, иначе из .deploy.json в корне
 * (gitignored; шаблон — .deploy.json.example). После create-deployment скрипт
 * сам допишет его в .deploy.json.
 *
 * Запуск из корня: npm run deploy      (боевой)
 *                  node scripts/deploy.js --dry-run   (показать шаги, ничего не делать)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const claspEntry = path.join(root, 'node_modules', '@google', 'clasp', 'build', 'src', 'index.js');
const WEBAPP_URL = (id) => 'https://script.google.com/macros/s/' + id + '/exec';

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

/** Выполнить команду; args — массив (никакой интерполяции в shell). */
function run(cmd, args, opts = {}) {
  const shown = opts.label || [cmd, ...args].join(' ');
  if (dryRun) {
    console.log('[dry-run] ' + shown);
    return '';
  }
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit' });
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    const tail = stderr ? '\n   ' + stderr.split('\n').slice(-6).join('\n   ') : '';
    if (/credential|login|authorized/i.test(stderr)) {
      die(
        'clasp не авторизован. Выполните интерактивный вход: npx clasp login\n' +
          '   Также проверьте, что Apps Script API включён:\n' +
          '   https://script.google.com/home/usersettings' +
          tail,
      );
    }
    die('Команда упала: ' + shown + tail);
  }
}

const clasp = (args, opts = {}) => {
  if (!fs.existsSync(claspEntry)) die('clasp не установлен. Выполните: npm ci');
  return run(process.execPath, [claspEntry, ...args], { ...opts, label: 'clasp ' + args.join(' ') });
};

// ── 0. Конфигурация проекта ──
const claspJsonPath = path.join(root, '.clasp.json');
if (!fs.existsSync(claspJsonPath)) {
  if (dryRun) {
    console.warn(
      '⚠️  .clasp.json не найден — в боевом запуске он обязателен (cp .clasp.json.example .clasp.json + scriptId).',
    );
  } else {
    die(
      '.clasp.json не найден. Первый раз? Выполните: npm run bootstrap\n' +
        '   Либо вручную: cp .clasp.json.example .clasp.json и впишите scriptId проекта.',
    );
  }
}

// ── 1. Проверки кода ──
console.log('── 1/5 · проверки (lint + smoke-тесты)');
// То же, что `npm run check`, но без shell-вызова npm (кроссплатформенно):
const eslintEntry = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
run(process.execPath, [path.join('scripts', 'build-bundle.js'), '--quiet'], { label: 'build:bundle' });
run(process.execPath, [eslintEntry, 'scripts', path.join('dist', 'BUNDLE.gs')], {
  label: 'eslint scripts dist/BUNDLE.gs',
});
run(process.execPath, [path.join('scripts', 'smoke-test.js')], { label: 'node scripts/smoke-test.js' });

// ── 2. Авторизация clasp ──
console.log('── 2/5 · авторизация clasp');
if (dryRun) {
  clasp(['show-authorized-user', '--json']);
} else {
  const authOut = clasp(['show-authorized-user', '--json'], { capture: true });
  let loggedIn = false;
  try {
    loggedIn = !!JSON.parse(authOut).loggedIn;
  } catch (_) {
    /* не-JSON вывод — проверим текстом */
  }
  if (!loggedIn && !/"loggedIn"\s*:\s*true/.test(authOut)) {
    die(
      'clasp не авторизован. Выполните интерактивный вход: npx clasp login\n' +
        '   (откроется браузер). Также проверьте, что Apps Script API включён:\n' +
        '   https://script.google.com/home/usersettings',
    );
  }
}

// ── 3. Push кода ──
console.log('── 3/5 · clasp push --force');
clasp(['push', '--force']);

// ── 4. Иммутабельная версия ──
console.log('── 4/5 · create-version');
let sha = 'local',
  subject = 'ручной деплой';
try {
  sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).trim();
} catch (_) {
  /* git недоступен — версия всё равно создаётся */
}
const versionDesc = sha + ' ' + subject;
const vOut = clasp(['create-version', versionDesc, '--json'], { capture: true });
let versionNumber;
try {
  versionNumber = JSON.parse(vOut).versionNumber;
} catch (_) {
  const m = String(vOut).match(/version\s+(\d+)/i) || String(vOut).match(/(\d+)/);
  versionNumber = m ? Number(m[1]) : undefined;
}
console.log(dryRun ? '   версия: (будет создана)' : '   версия: ' + versionNumber + ' — «' + versionDesc + '»');

// ── 5. Развёртывание ──
console.log('── 5/5 · развёртывание веб-приложения');
let deploymentId = process.env.DEPLOYMENT_ID || '';
const deployJsonPath = path.join(root, '.deploy.json');
if (!deploymentId && fs.existsSync(deployJsonPath)) {
  try {
    deploymentId = JSON.parse(fs.readFileSync(deployJsonPath, 'utf8')).deploymentId || '';
  } catch (_) {
    die('.deploy.json битый — исправьте JSON или удалите файл');
  }
}

if (deploymentId) {
  clasp(
    [
      'update-deployment',
      deploymentId,
      '-d',
      versionDesc,
      ...(versionNumber ? ['-V', String(versionNumber)] : []),
      '--json',
    ],
    { capture: true },
  );
  console.log('   обновлено существующее развёртывание ' + deploymentId + ' — URL не меняется, webhook не отвалится');
} else {
  const dOut = clasp(
    ['create-deployment', '-d', versionDesc, ...(versionNumber ? ['-V', String(versionNumber)] : []), '--json'],
    { capture: true },
  );
  try {
    deploymentId = JSON.parse(dOut).deploymentId;
  } catch (_) {
    /* распарсим ниже по тексту */
  }
  if (!deploymentId) {
    const m = String(dOut).match(/Deployed\s+(AK[\w-]+)/) || String(dOut).match(/(AK[\w-]{20,})/);
    deploymentId = m ? m[1] : '';
  }
  if (deploymentId && !dryRun) {
    fs.writeFileSync(deployJsonPath, JSON.stringify({ deploymentId }, null, 2) + '\n');
    console.log('   создано новое развёртывание ' + deploymentId + ' → сохранено в .deploy.json (gitignored)');
    console.log('   ⚠️  НОВОЕ развёртывание — если webhook уже был настроен на старое, перепустите setupWebhook');
  } else if (!dryRun) {
    console.log(
      '   deploymentId не распознан из вывода clasp — посмотрите `npx clasp deployments` и впишите в .deploy.json',
    );
  }
}

if (deploymentId) {
  console.log('\n✅ Деплой завершён. Веб-приложение: ' + WEBAPP_URL(deploymentId));
} else {
  console.log('\n✅ Код запушен и версия создана' + (dryRun ? ' (dry-run)' : ''));
}
