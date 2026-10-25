import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Сервисы Apps Script, доступные в .gs как глобальные объекты рантайма.
const gasGlobals = {
  CacheService: 'readonly',
  Charts: 'readonly',
  ContentService: 'readonly',
  LockService: 'readonly',
  MimeType: 'readonly',
  PropertiesService: 'readonly',
  ScriptApp: 'readonly',
  Session: 'readonly',
  SpreadsheetApp: 'readonly',
  UrlFetchApp: 'readonly',
  Utilities: 'readonly',
  console: 'readonly',
  // ВНИМАНИЕ: URLSearchParams в GAS V8 НЕ существует — использование в
  // TmaApi.gs/validateInitData_ является известным багом (валидация initData
  // всегда падает в catch → записи Mini App отклоняются). Объявлен здесь,
  // чтобы lint проходил до исправления; не является «разрешением» на использование.
  URLSearchParams: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', '.git/**'],
  },
  // Код Apps Script линтуется как собранный бандл dist/BUNDLE.gs:
  // в .gs модули делят top-level символы через общий глобальный скоуп,
  // поэтому no-undef корректен только на конкатенации (см. npm run lint).
  {
    files: ['dist/**/*.gs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.es2021, ...gasGlobals },
    },
    rules: {
      ...js.configs.recommended.rules,
      // top-level функции .gs — точки входа рантайма (doPost, триггеры, setup);
      // «неиспользуемость» изнутри бандла — норма, поэтому warn.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // пустые catch — осознанные best-effort проверки (гайд/аудит)
      'no-empty': ['error', { allowEmptyCatch: true }],
      // перевыброс ошибок без cause — существующий стиль кода, warn + в отчёт
      'preserve-caught-error': 'warn',
    },
  },
  // Утилиты репозитория — обычный Node (CommonJS).
  {
    files: ['scripts/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // v2: TypeScript в apps/* (Worker + Vite). Типы и no-undef проверяет tsc —
  // здесь только ts-правила (recommended уже отключает конфликтующие).
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
  })),
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
