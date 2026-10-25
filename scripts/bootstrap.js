#!/usr/bin/env node
/**
 * bootstrap.js — первичная настройка проекта Apps Script (один раз):
 *
 *   проверка авторизации → clasp create --type standalone → push →
 *   печать следующих ручных шагов (Script Properties, setup(), webhook).
 *
 * Предусловия (ручные, один раз):
 *   npm ci
 *   npx clasp login            — интерактивный вход через браузер
 *   Apps Script API включён:   https://script.google.com/home/usersettings
 *
 * Запуск из корня: npm run bootstrap
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const claspEntry = path.join(root, 'node_modules', '@google', 'clasp', 'build', 'src', 'index.js');
const claspJsonPath = path.join(root, '.clasp.json');

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

const clasp = (args) =>
  execFileSync(process.execPath, [claspEntry, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const claspInherit = (args) => execFileSync(process.execPath, [claspEntry, ...args], { cwd: root, stdio: 'inherit' });

if (!fs.existsSync(claspEntry)) die('clasp не установлен. Выполните: npm ci');

if (fs.existsSync(claspJsonPath)) {
  die('.clasp.json уже существует — проект уже привязан. Для обновления кода используйте npm run deploy.');
}

// Авторизация — обязательна до create
// (show-authorized-user всегда выходит с кодом 0 — проверяем вывод)
let authOut = '';
try {
  authOut = clasp(['show-authorized-user', '--json']);
} catch (_) {
  /* упадёт ниже по содержимому */
}
let loggedIn = false;
try {
  loggedIn = !!JSON.parse(authOut).loggedIn;
} catch (_) {
  /* не-JSON вывод — проверим текстом */
}
if (!loggedIn && !/"loggedIn"\s*:\s*true/.test(authOut)) {
  die(
    'clasp не авторизован.\n' +
      '   1) Включите Apps Script API: https://script.google.com/home/usersettings\n' +
      '   2) Выполните вход (откроется браузер): npx clasp login\n' +
      '   3) Повторите: npm run bootstrap',
  );
}

console.log('── Создаю standalone-проект Apps Script «Budget Companion»…');
try {
  claspInherit(['create', '--type', 'standalone', '--title', 'Budget Companion', '--rootDir', 'apps-script']);
} catch (e) {
  die(
    'clasp create не удался. Если в тексте ошибки есть про Apps Script API —\n' +
      '   включите его: https://script.google.com/home/usersettings\n' +
      '   Детали: ' +
      (e.stderr || e.message || e),
  );
}

if (!fs.existsSync(claspJsonPath)) die('clasp не записал .clasp.json — проверьте вывод выше.');
console.log('✅ .clasp.json создан (scriptId сохранён локально; файл в .gitignore)');

console.log('── Пушу код в новый проект…');
try {
  claspInherit(['push']);
} catch (e) {
  die('clasp push не удался: ' + (e.stderr || e.message || e));
}

console.log(`
✅ Проект создан и код запушен. Дальше — вручную в редакторе Apps Script:

   1. Откройте проект:  npx clasp open-script
   2. ⚙ Настройки проекта → Часовой пояс → ваш (например, (UTC+6) Бишкек).
   3. ⚙ Настройки проекта → Свойства сценария → добавьте:
        TELEGRAM_BOT_TOKEN  — токен от @BotFather
        TELEGRAM_CHAT_ID    — ваш chat_id (@userinfobot)
        GEMINI_API_KEY      — ключ с https://aistudio.google.com/apikey
      (опционально GROQ_API_KEY, GH_BACKUP_TOKEN/GH_BACKUP_REPO — см. SETUP.md)
   4. Выполните функцию createSpreadsheet — создаст таблицу и листы.
   5. Разверните веб-приложение: npm run deploy — скрипт создаст развёртывание,
      сохранит его id в .deploy.json и напечатает URL.
   6. В редакторе выполните setupWebhook, затем setupBotProfile и securityAudit.

   Подробно: SETUP.md`);
