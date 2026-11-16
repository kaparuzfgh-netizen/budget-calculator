---
description: Полная проверка проекта (lint + typecheck + тесты + сборка web)
allowed-tools: Bash(npm run check:*), Bash(npm run typecheck:*), Bash(npm test:*), Bash(git status:*), Bash(git diff:*)
---

Запусти `npm run check`. При падении покажи первую ошибку с `file:line`,
найди причину и предложи (или внеси, если правка очевидна) минимальный фикс,
затем повтори `check`. Ничего не коммить.
