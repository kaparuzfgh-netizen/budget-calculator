#!/usr/bin/env node
/**
 * build-bundle.js — собирает весь бэкенд в один файл dist/BUNDLE.gs.
 *
 * Бандл — опциональный артефакт (удобно отдать одним файлом); сам он в репозиторий
 * не коммитится (dist/ в .gitignore) и в Apps Script не пушится. Основной путь
 * разработки и деплоя — clasp (см. SETUP.md).
 *
 * ORDER — порядок конкатенации модулей; его же использует smoke-test.js,
 * поэтому добавленный в apps-script/ *.gs обязан попасть в ORDER.
 *
 * Запуск из корня репозитория: node scripts/build-bundle.js  (или npm run build:bundle)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC_DIR = path.join(root, 'apps-script');
const OUT = path.join(root, 'dist', 'BUNDLE.gs');

const ORDER = [
  'Config.gs',
  'SheetService.gs',
  'TelegramService.gs',
  'Setup_Sheets.gs',
  'Code.gs',
  'CashflowEngine.gs',
  'DebtEngine.gs',
  'VisionParser.gs',
  'InvestNetWorth.gs',
  'FXAnalytics.gs',
  'MetricsEngine.gs',
  'AnomalyEngine.gs',
  'TmaApi.gs',
  'Triggers.gs',
  'SecurityAudit.gs',
];

const HEADER = [
  '/**',
  ' * BUNDLE.gs — ЕДИНЫЙ файл всего бэкенда (опциональный артефакт сборки).',
  ' * Сгенерирован автоматически: scripts/build-bundle.js (npm run build:bundle).',
  ' *',
  ' * Основной способ установки и обновления — clasp (SETUP.md):',
  ' * `npm run bootstrap` (первый раз) и `npm run deploy` (обновления).',
  ' * Этот файл нужен только если код хочется передать/вставить одним куском:',
  ' * тогда его содержимое вставляется ЦЕЛИКОМ в пустой Code.gs нового проекта',
  ' * Apps Script — вместо clasp и вместо отдельных модулей (не одновременно,',
  ' * иначе будут конфликты имён).',
  ' */',
].join('\n');

const SECTION = (f) =>
  '\n// ════════════════════════════════════════════════════════════════════\n' +
  '// ' +
  f +
  '\n' +
  '// ════════════════════════════════════════════════════════════════════\n';

function buildSource() {
  return HEADER + ORDER.map((f) => SECTION(f) + fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('');
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const src = buildSource();
  fs.writeFileSync(OUT, src);
  if (!process.argv.includes('--quiet')) {
    console.log(
      '✅ ' + path.relative(root, OUT) + ' (' + src.split('\n').length + ' строк, ' + ORDER.length + ' модулей)',
    );
  }
}

module.exports = { ORDER, SRC_DIR, OUT, buildSource };
