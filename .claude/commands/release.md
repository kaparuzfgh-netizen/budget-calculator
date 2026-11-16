---
description: Релиз в прод (check → web → миграции D1 → deploy → /health)
allowed-tools: Bash(npm run check:*), Bash(npm run release:*), Bash(git status:*), Bash(git log:*)
---

Правило 7 AGENTS.md: деплой выполняет агент при зелёном `check`.

1. `git status` — убедись, что нет неожиданных изменений; перечисли новые миграции.
2. `npm run check`; при красном — остановись и покажи причину.
3. `npm run release`. Если нужен `wrangler login` или `wrangler secret put` —
   остановись и попроси владельца (интерактивно делает только он).
4. Сообщи результат `/health` и применённые миграции.

Для стейджинга: `npm run release:staging`.
