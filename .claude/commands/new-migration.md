---
description: Создать новую миграцию D1 с проверкой правил проекта
argument-hint: <короткое_имя_миграции>
allowed-tools: Read, Glob, Grep, Write, Bash(ls:*)
---

Создай миграцию `apps/api/migrations/NNNN_$ARGUMENTS.sql`, где NNNN — следующий
номер после последнего файла в каталоге (проверь `ls`). Старые миграции
не редактировать (иммутабельны).

Чеклист:
- пользовательская таблица имеет `user_id` + индекс по нему; `UNIQUE(user_id, source_key)` для идемпотентных записей;
- деньги — `INTEGER` minor units;
- текстовые/денежные колонки пользователя → добавь в `FIELDS` (`apps/api/src/db/crypto.ts`) и храни как `enc1:`;
- доступ только через `scoped()` в `repo.ts` + тест «A не видит B»;
- обнови `docs/ARCHITECTURE.md` (таблица таблиц) — или оставь `documenter`.

Применение локально: `npm run wrangler -- d1 migrations apply DB --local`.
