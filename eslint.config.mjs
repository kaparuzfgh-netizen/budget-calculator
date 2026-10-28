import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/**', '.git/**'],
  },
  // Утилиты репозитория — обычный Node (CommonJS/ESM).
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // TypeScript в apps/* (Worker + Vite). Типы и no-undef проверяет tsc —
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
