# ARCHITECTURE_PLAN.md

Снимок на 2026-11-17. Подробности — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
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
| B1 | **Файлы-«god object»**: `db/repo.ts` 1753 строк, `services/access.ts` 883, `web/screens/profile.tsx` 1042, `home.tsx` 935, `debts.tsx` 862. Растёт стоимость изменений и ревью; repo.ts — единая точка tenant-изоляции, поэтому правки в нём рискованны | `wc -l` | P2 |
| B2 | **Дрейф документации**: `docs/ARCHITECTURE.md` говорит «19 таблиц» / «18 таблиц» и миграции «0001–0014», фактически 0001–0020 (нет `households`/`household_members` и других поздних таблиц); README уже ссылается на v2, но таблицы не обновлены | сравнение с `apps/api/migrations` | P3 |
| B3 | **Нет корневого `.env.example`**: переменные описаны только в `apps/api/.dev.vars.example`; корневой `.env` (в .gitignore) читается скриптами `scripts/env.mjs` — его формат нигде не задокументирован | `ls`, `scripts/env.mjs` | P3 |
| B4 | **Потеря истории платежей**: `patchCommitment` затирает прежнюю сумму, рост обязательных не объяснить (BACKLOG P2-10) | `docs/BACKLOG.md` | P2 |
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

### План задачи T1: История изменений платежей

**Цель.** Каждое изменение платежа (`patchCommitment`) оставляет append-only
запись «было → стало»; в деталях платежа в Mini App — лента изменений.
Границы: только чтение ленты и запись при правке. Откат/«восстановить
значение» и использование в дайджесте (T2) — вне задачи.

**Решения.**
- Поля в журнале: `name`, `amount` (+`currency` как отдельное поле), `due_day`, `active`, `cadence` (одно поле: сериализация `frequency|interval_days|anchor_on|due_month|every_months`). `old_val`/`new_val` — строки, шифруются целиком (`str`), т.к. имена и суммы приватны.
- Единая точка записи — `patchCommitment` в `db/repo.ts` (покрывает и бот через `flows.ts`, и TMA). Логируем только реально изменившиеся значения (сравнение с текущей строкой); пустой diff — запись не создаётся.
- Журнал и обновление — в одном `db.batch` (атомарно). Сначала `getCommitment(id)` с `user_id`-предикатом; чужой/несуществующий id → ничего не пишем (как сейчас, молча).
- Идемпотентность: повторная правка тем же значением даёт пустой diff, дублей нет; `client_id` не нужен.
- Удаление платежа удаляет и его историю (как `commitment_payments`).

**Данные.** Миграция `apps/api/migrations/0021_commitment_changes.sql`:
`commitment_changes(id PK, user_id NOT NULL REFERENCES users(id), commitment_id NOT NULL, field TEXT NOT NULL CHECK(field IN (...)), old_val TEXT, new_val TEXT, changed_at TEXT NOT NULL DEFAULT (datetime('now')))`
+ индекс `(user_id, commitment_id, id)`. `FIELDS += commitment_changes: { old_val:'str', new_val:'str' }` в `db/crypto.ts` (backfill подхватит автоматически).

**Шаги.**
1. Миграция 0021 + запись в `FIELDS`; типы строки (`CommitmentChangeRow`) в `repo.ts`.
2. `patchCommitment`: читать текущую строку, посчитать diff по полям, собрать `INSERT INTO commitment_changes` (значения через `en(...)`) и добавить в `db.batch` вместе с `UPDATE`. Вернуть прежний тип результата (проверить вызовы в `flows.ts:260`, `tma/commitments.ts:229`).
3. `repo.listCommitmentChanges(commitmentId, limit=50)` — `WHERE user_id=? AND commitment_id=? ORDER BY id DESC`, `decRows`.
4. `deleteCommitment` — добавить `DELETE FROM commitment_changes WHERE user_id=? AND commitment_id=?` в batch; `deleteAllUserData` — таблица в начало списка (children first); `exportUserData` — секция `commitment_changes`, `schema_version` 5→6.
5. TMA: `GET /api/tma/commitments/:id/changes` (Bearer, `getCommitment` → 404 для чужого; ответ `{changes:[{id, field, old, new, changed_at}]}`; суммы отдавать как minor units + currency, а не строкой).
6. Web: в деталях платежа (`apps/web/src/screens/…` — найти экран деталей платежа) лента «было → стало» (суммы через `fmt`, цвета только токенами палитры).
7. Тесты (api): diff пишет только изменённые поля; пустой patch — 0 записей; «A не видит B» (список изменений чужого платежа → 404, чужие записи не в выдаче); шифрование (в D1 `enc1:`, ключ `commitment_changes.old_val:<uid>`); удаление платежа и `/delete_me` чистят журнал; `/export` содержит секцию. Обновить списки таблиц в `privacy.test.ts` (строки 38, 53) и `encryption.test.ts` (стр. 19). Тест web на рендер ленты, если есть паттерн в `apps/web`.
8. `npm run check` зелёный.

**Риски.** (а) `patchCommitment` вызывается из бота и TMA с разными наборами полей — сравнивать по значениям после дешифровки, а не по наличию ключа; (б) суммы в `old_val` — строки minor units, валюту менять отдельным полем, иначе лента вводит в заблуждение; (в) рост таблицы — лимит выдачи 50, чистка не нужна (правка редкая). Откат — новой миграцией `DROP TABLE` (старые не трогаем).

**Документация (для documenter).** `docs/ARCHITECTURE.md` (таблица + миграции), `docs/BACKLOG.md` (вычеркнуть P2-10), `docs/USER_GUIDE.md`, `/export` в README/SECURITY при упоминании схемы.

Задачу можно переводить в `[READY]` после подтверждения плана.
