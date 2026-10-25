# src/domain — чистые функции домена

Порт расчётов из `apps-script/*.gs` — **без ввода-вывода** (никаких `fetch`,
`env.DB`, `new Date()`/`Date.now()` — «сегодня» всегда параметром ISO-строкой
`'YYYY-MM-DD'`). Числа-эталоны: golden-тест `test/domain/golden.test.ts` сверяет
каждый кейс с реальным выводом legacy-кода (`npm run golden` пересобирает
`test/domain/golden.legacy.json`).

| Модуль | Что | Источник v1 |
|--------|-----|-------------|
| `errors.ts` | `DomainError` (code + русское сообщение), валидация чисел | — |
| `money.ts` | `Currency`, `FxRates.perUsd`, `convert` через USD, `round2` | `SheetService.convert_` |
| `dates.ts` | `addMonths` (клэмп конца месяца), `isoWeek` (ISO-год!), `daysInMonth`, `daysLeftInMonth` | `SheetService.isoWeek_/daysLeftInMonth_` |
| `debt.ts` | аннуитет, инверсия срока, `replay` журнала событий, ЧДП «платёж ↓/срок ↓», проекция, арбитраж вклад/долг | `DebtEngine.gs` |
| `cashflow.ts` | водопад месяца: обязательства → лимит жизни → профицит → каскад дельты | `CashflowEngine.computeWaterfall` |
| `budget.ts` | недельный/месячный бюджет, burn rate, дневной остаток, антимиспарс | `CashflowEngine.weeklyStatus` |

Осознанные отличия от legacy: `remainingPeriods` считается инверсией от текущего
состояния (как показывал Mini App), ISO-неделя сравнивается по ISO-году
(legacy терял неделю на границе календарного года), `addMonths` не проваливает
31-е число.
