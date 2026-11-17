# ARCHITECTURE_PLAN.md

Снимок на 2026-11-17 (после T1–T6). Подробности — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[ADR-0001](docs/adr/0001-platform-and-architecture.md). Планы по задачам из
`TASKS.md` добавляются ниже агентом `architect` (раздел «План задачи: …»).

## 1. Текущая архитектура

Один Cloudflare Worker (`budget-companion-api`) = webhook Telegram + REST
Mini App (`/api/tma/*`, Bearer JWT) + статика SPA (Workers Static Assets) +
часовой cron. Хранилище — D1 (SQLite, миграции 0001–0020).

| Слой | Где | Роль |
|---|---|---|
| HTTP | `apps/api/src/http`, `index.ts` | Hono-роутер, fail-closed проверка webhook-секрета |
| Доступ | `services/access.ts`, `bot/onboarding.ts` | владелец / инвайт / тишина для чужих |
| Бот | `apps/api/src/bot`, `services/flows.ts` | команды, мастера (реестр `Flow`), навигация по `screens.json` |
| Mini App API | `apps/api/src/tma` | auth (initData HMAC → JWT 12ч), экраны, `client_id`-идемпотентность |
| Домен | `apps/api/src/domain` | чистые функции: бюджет, кредиты, займы, FX, отчёты |
| Данные | `db/repo.ts` (`scoped`), `db/crypto.ts` | tenant-изоляция + AES-GCM `enc1:` at rest |
| Внешнее | `fx/` (Frankfurter), `vision/` (Gemini→Groq), `telegram/` | таймауты, кэш курсов 6ч |
| Cron | `services/reminders.ts` | напоминания, автопроводки, FX-алерты, дайджесты (идемпотентно через `reminder_log`) |
| Web | `apps/web/src` (Vite+Preact+Tailwind v4) | SPA, светлая/тёмная тема |

Фичи, уже в проде: бюджет и `/plan`, платежи с автопроводкой, кредиты и ЧДП,
личные займы, категории и отчёты, vision по скриншотам, FX-аналитика,
общий бюджет пары (households), каскад бонуса, шифрование at rest.
Состояние качества: все пункты `AUDIT_REPORT.md` (P1–P3, A2-*) закрыты.

## 2. Узкие места и техдолг

| # | Проблема | Подтверждение | Серьёзность |
|---|---|---|---|
| B1 | ~~**Файлы-«god object»**~~ ✅ частично закрыто (T6): repo.ts → `db/scoped/*`, web-экраны profile/home/debts разбиты; остаются `services/access.ts` (883) и `ProfileForms`. Исходно: **Файлы-«god object»**: `db/repo.ts` 1753 строк, `services/access.ts` 883, `web/screens/profile.tsx` 1042, `home.tsx` 935, `debts.tsx` 862. Растёт стоимость изменений и ревью; repo.ts — единая точка tenant-изоляции, поэтому правки в нём рискованны | `wc -l` | P2 |
| B2 | ~~**Дрейф документации**~~ ✅ закрыто (T4) — **Дрейф документации**: `docs/ARCHITECTURE.md` говорит «19 таблиц» / «18 таблиц» и миграции «0001–0014», фактически 0001–0020 (нет `households`/`household_members` и других поздних таблиц); README уже ссылается на v2, но таблицы не обновлены | сравнение с `apps/api/migrations` | P3 |
| B3 | ~~**Нет корневого `.env.example`**~~ ✅ закрыто (T5) — **Нет корневого `.env.example`**: переменные описаны только в `apps/api/.dev.vars.example`; корневой `.env` (в .gitignore) читается скриптами `scripts/env.mjs` — его формат нигде не задокументирован | `ls`, `scripts/env.mjs` | P3 |
| B4 | ~~**Потеря истории платежей**~~ ✅ закрыто (T1) — **Потеря истории платежей**: `patchCommitment` затирает прежнюю сумму, рост обязательных не объяснить (BACKLOG P2-10) | `docs/BACKLOG.md` | P2 |
| B5 | **Cron-окна и пачки**: надёжность закрыта аудитом (окна, догоняющая автопроводка, пачки по 8), но при росте пользователей лимиты Workers Free (subrequests/CPU за тик) — главный потолок; мониторинга лимитов нет | AUDIT_REPORT P1-1, «Отложено» | P2 |
| B6 | **Единая точка отказа ключа**: потеря `DATA_KEY` необратима (DR-план описан в аудите A2-3, но восстановление не автоматизировано) | AUDIT_REPORT A2-3 | P2 |
| B7 | **Только русский язык** UI, строки зашиты в код (BACKLOG P2-13) | BACKLOG | P3 |
| B8 | **Последовательные `user.id`** — безопасно, пока id не вход клиента; любой новый эндпоинт с user_id параметром = IDOR | AGENTS.md правило 3 | инвариант |

## 3. Рекомендуемый порядок

1. История изменений платежей (B4) → 2. Дайджест месяца (зависит от 1) →
3. Актуализация docs/ARCHITECTURE.md и `.env.example` (B2, B3) →
4. Декомпозиция `repo.ts` по доменам без смены публичного API `scoped()` (B1) →
5. Инвестиции (поэтапно) → 6. Мультиязычность и игровая тема (по решению владельца в конец).

## 4. Планы задач

_Пока пусто. `architect` добавляет раздел при переводе задачи в `[DESIGN]`; после `[DONE]` раздел удаляется (история — в git и CHANGELOG)._
