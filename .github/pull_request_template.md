## Что изменено

<!-- коротко: что и зачем -->

## Чеклист

- [ ] `npm run check` проходит локально (lint + typecheck + тесты API + сборка web)
- [ ] Секреты и `.dev.vars` не закоммичены (прод — `wrangler secret put`)
- [ ] Новый SQL — только новым файлом `apps/api/migrations/NNNN_name.sql`
- [ ] Запросы к БД идут через `scoped(db, userId)` в `repo.ts`; для новых чтений — тест изоляции «A не видит B»
- [ ] Изменения экранов бота внесены в `docs/ux/navigation.md` + `screens.json` (nav.test.ts зелёный)
- [ ] Документация обновлена (README/SETUP/CHANGELOG), если менялось поведение или установка
