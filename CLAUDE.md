# CLAUDE.md

Правила проекта для Claude Code. Полный технический реестр правил (№1–20)
живёт в [AGENTS.md](AGENTS.md) и **обязателен**; здесь — сжатая выжимка и
конвейер задач. При конфликте приоритет у AGENTS.md.

@AGENTS.md

## Проект

Budget Companion — мультипользовательский Telegram-бот + Mini App личных
финансов на Cloudflare (v2; legacy Apps Script удалён, ADR-0001).

- `apps/api` — Cloudflare Worker: TypeScript strict, Hono, D1, cron, zod,
  vision (Gemini → Groq), FX (Frankfurter). Тесты — vitest в workerd.
- `apps/web` — Mini App: Vite + Preact + Tailwind v4, раздаётся тем же
  воркером (Workers Static Assets).
- `scripts/` — setup / release / webhook (Node ESM). `docs/` — архитектура,
  ADR, UX-навигация, BACKLOG.

## Команды

| Команда | Что делает |
|---|---|
| `npm ci` | зависимости (workspaces `apps/*`) |
| `npm run check` | lint + typecheck + тесты api/web + сборка web. **Обязательно перед коммитом** |
| `npm test` / `test:api` / `test:web` | тесты |
| `npm run dev -w apps/api` | локальный воркер + D1 |
| `npm run release` | check → web → миграции D1 → deploy → /health |
| `npm run wrangler -- <cmd>` | wrangler из workspace apps/api |

Деплой выполняет агент сам (`npm run release`) при зелёном `check`.
Только владелец: `wrangler login/logout`, `wrangler secret put`, секреты CI.

## Конвенции (выжимка — детали в AGENTS.md)

- **Workers ≠ Node:** в `apps/api` только Web API; без `process/fs/Buffer/node:*`.
- **Tenant (правило 3):** БД только через `scoped(env.DB, userId)` в
  `db/repo.ts` (части — `db/scoped/*`); каждый запрос с `WHERE user_id = ?`, мутации по id —
  `WHERE id=? AND user_id=?`. Сырой `db.prepare` вне repo.ts запрещён.
  Новый эндпоинт/запрос ⇒ тест «A не видит B». `user_id` — никогда не вход клиента.
- **Деньги:** INTEGER minor units в D1; домен (`src/domain/`) — чистые функции
  без I/O, float, `toMinor/fromMinor` на границе repo; «сегодня» — параметром.
- **Шифрование (правило 19):** новая текстовая/денежная колонка пользователя
  ⇒ запись в `FIELDS` (`db/crypto.ts`), без сырых WHERE по ней.
- **Миграции:** только новые `apps/api/migrations/NNNN_name.sql`
  (сейчас последняя — 0020), старые иммутабельны.
- **Валидация:** zod на каждом входе; Mini App API `/api/tma/*` — Bearer JWT,
  `client_id` для идемпотентности, те же правила, что у бота.
- **Секреты и логи:** ничего секретного в git и URL; в логах вебхука —
  только `update_id` и код ошибки (правило 10).
- **Навигация бота:** сначала `docs/ux/navigation.md` + `screens.json`,
  потом код; нав-ряды через `navRow()`.
- **Mini App UI:** цвета только токенами палитры (dark/light), literal
  `white|black/<alpha>` запрещён.
- Язык кода/идентификаторов — английский; UI, комментарии, коммиты и доки — русский.

## Конвейер задач

Единый источник задач — [TASKS.md](TASKS.md) (детальный бэклог продукта —
`docs/BACKLOG.md`; при закрытии пункта обновлять оба). Статус стоит в
заголовке задачи, движение — строго по порядку:

```
[REVIEW] → [DESIGN] → [READY] → [DOCS] → [DONE]
```

| Статус | Смысл | Кто | Выход |
|---|---|---|---|
| `[REVIEW]` | идея/задача, риски не проверены | `advisor` | список рисков, вердикт go/no-go, правки формулировки |
| `[DESIGN]` | нужен план реализации | `architect` | пошаговый план в `ARCHITECTURE_PLAN.md` (файлы, миграции, тесты) |
| `[READY]` | план утверждён, можно кодить | `executor` | код + тесты, `npm run check` зелёный |
| `[DOCS]` | код готов, доки отстают | `documenter` | обновлены README / `.env.example` / `.dev.vars.example` / docs по `git diff` |
| `[DONE]` | всё сделано | — | задача вычёркивается в TASKS.md и BACKLOG.md |

Правила конвейера:

1. Статус меняет тот, кто завершил свою стадию, одной правкой TASKS.md.
2. Стадии не перепрыгиваются; тривиальные правки (опечатка, 1 файл) можно
   вести сразу `[READY]`.
3. `executor` не отступает от плана: если план не работает — вернуть задачу
   в `[DESIGN]` с пояснением, а не импровизировать.
4. Коммит и деплой — только по запросу пользователя (деплой — по правилу 7
   AGENTS.md при зелёном `check`).

## Субагенты (`.claude/agents/`)

`advisor` (opus, read-only+web) · `architect` (opus, пишет только
ARCHITECTURE_PLAN.md) · `executor` (sonnet, код+тесты) · `documenter`
(haiku, доки по diff). Slash-команды — `.claude/commands/`
(`/check`, `/release`, `/new-migration`, `/task`).

## Память вне репозитория

`.devin/` — наследие Devin Desktop (только `config.local.json` с allow-списком
команд); в Claude Code не используется.
