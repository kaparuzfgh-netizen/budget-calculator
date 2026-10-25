# Участие в проекте

Проект частный — изменения вносит владелец и приглашённые участники.

## Среда

- Node.js ≥ 20 (в `.nvmrc` — 22). Зависимости: `npm ci`.
- Локальный clasp уже в devDependencies — глобально ставить не нужно.

## Команды

| Команда | Что делает |
|---------|-----------|
| `npm run check` | lint + smoke-тесты — **запускать перед каждым коммитом** |
| `npm test` | офлайн-тесты бэкенда (моки Apps Script, без сети и Google) |
| `npm run lint` | eslint: `scripts/` + собранный `dist/BUNDLE.gs` |
| `npm run lint:sh` | shellcheck по sh-скриптам (если установлен) |
| `npm run format` / `format:check` | prettier по tooling и конфигам (не трогает `apps-script/`, `mini-app/`) |
| `npm run build:bundle` | собрать `dist/BUNDLE.gs` (опциональный артефакт) |
| `npm run bootstrap` | первичная привязка к проекту Apps Script (после `npx clasp login`) |
| `npm run push` / `deploy` | `clasp push` / полный цикл: check → push → версия → развёртывание |

## Правила

1. **Секреты не коммитим.** Значения — только в Script Properties Apps Script;
   локально — `secrets.json` (в `.gitignore`). pre-commit хук и gitleaks
   страхуют, но не заменяют внимательность.
2. **`BUNDLE.gs` не добавляем в `apps-script/`** — туда попадает только то,
   что должно уехать в Apps Script (`*.gs` + `appsscript.json`). Бандл при
   необходимости собирается в `dist/` командой `npm run build:bundle`.
3. **Новый модуль `apps-script/*.gs` → в `ORDER`** в `scripts/build-bundle.js`
   (smoke-тест A0 проверяет покрытие). В `.gs` модули делят top-level символы
   через общий глобальный скоуп — порядок в `ORDER` важен: зависимости
   (Config, SheetService) идут первыми.
4. Пользовательский код Apps Script — ES5+/V8 без web-API (`fetch`,
   `URLSearchParams`, `atob` и т.п. недоступны — см. CONTRIBUTING-заметку
   в `eslint.config.mjs`); вместо них — сервисы `UrlFetchApp`, `Utilities`.
5. Бизнес-логика движков не правится в стилевых PR; мелкие текстовые правки —
   отдельным коммитом от функциональных.
6. Документация — на русском, стиль как в README/SETUP.

## Стиль

- `scripts/*.js` — CommonJS, Node ≥20, без новых runtime-зависимостей.
- Конфиги и scripts форматируются prettier (`npm run format`).
- Коммиты — русским языком, как в истории репозитория.

## Деплой

`npm run deploy` делает всё: `npm run check` → `clasp push --force` →
иммутабельная версия (описание = git sha + subject) → обновление развёртывания
из `.deploy.json` (или `DEPLOYMENT_ID`) — URL веб-приложения при этом
**не меняется**, webhook не отваливается. Первый раз: `npm run bootstrap`
(создаст проект и `.clasp.json`), затем шаги из SETUP.md.
