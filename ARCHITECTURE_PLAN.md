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

### План задачи: T3a Инвестиции: ручной портфель

Источник: `TASKS.md` T3 (вердикт advisor — GO с правками), BACKLOG P1-9, ADR-0001 п.10.
Правила: AGENTS.md 3, 10, 11, 12, 19, 20.

#### 0. Что получится для пользователя

- В Mini App появляется экран **«💼 Инвестиции»**: список позиций (вклад, облигация,
  крипта, акция, другое), у каждой — количество, цена, текущая стоимость и
  результат «+/−» к цене покупки (если она указана). Вверху — итог портфеля в
  базовой валюте и доли по видам («вклады 40% · крипта 25% …»).
- Позицию можно добавить, исправить и удалить. Цены вводятся вручную (с датой
  «цена на …»; если цене больше 30 дней — мягкая пометка «обновите цену»).
- Для вклада — сумма, ставка, даты открытия/окончания; показывается
  «≈ начислено» по простой формуле.
- Можно задать **цели распределения** по видам (в процентах, сумма 100).
  Тогда в «Плане» часть бонуса, идущая на инвестиции (DCA), раскладывается по
  этим целям, вместо нынешней заглушки.
- В боте — экран-итог «💼 Инвестиции» (`/invest`): сумма портфеля и доли;
  редактирование — в Mini App (вариант по умолчанию, см. вопросы).
- Везде подпись: «Это учёт, а не инвестиционная рекомендация».
- Если для валюты позиции нет курса — позиция видна, но в итог не входит, с
  пометкой «нет курса для XXX» (не ноль и не ошибка всего экрана).

#### 1. Цель и границы

**Входит:** таблица `holdings`, ручные цены, оценка в базовой валюте через
`getFxRates`, цели распределения → `dcaTargets` каскада (бот `/plan` и
`GET /api/tma/plan`), CRUD в Mini App, экран-итог в боте, `/export`
(schema_version 6 → 7) и `/delete_me`, шифрование всех чувствительных полей.

**Не входит (отдельные задачи):** T3b автоцена крипты (CoinGecko), T3c
облигации/акции (MOEX), T3d журнал сделок (покупки/продажи, средняя цена по
сделкам) и напоминания о погашении вклада/облигации. Никаких внешних API цен,
никакого cron, никаких пушей. Партнёру в household — ничего (см. вопрос 3).
Портфель НЕ влияет на `computedBaselineUsd`, «подушку» и дайджест.

#### 2. Данные — миграция `apps/api/migrations/0023_holdings.sql`

```sql
-- 0023_holdings.sql — ручной инвест-портфель (T3a, шаг 10 этап 1).
CREATE TABLE IF NOT EXISTS holdings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('deposit','bond','crypto','stock','other')),
  name         TEXT    NOT NULL,   -- enc1: str
  ticker       TEXT,               -- enc1: str (задел под T3b/T3c)
  currency     TEXT    NOT NULL,   -- валюта цены/суммы, plaintext (как loans.currency)
  quantity     TEXT,               -- enc1: str, каноническая десятичная строка '0.12345678'
  avg_price    TEXT,               -- enc1: str, цена покупки за единицу (десятичная строка)
  price        TEXT,               -- enc1: str, текущая ручная цена за единицу
  price_on     TEXT,               -- 'YYYY-MM-DD' дата ручной цены, plaintext
  amount_minor INTEGER,            -- enc1: num, сумма для deposit/other (minor units)
  rate         REAL,               -- enc1: num, % годовых (deposit/bond)
  opened_on    TEXT,               -- 'YYYY-MM-DD', plaintext
  matures_on   TEXT,               -- 'YYYY-MM-DD', plaintext
  note         TEXT,               -- enc1: str
  source_key   TEXT,               -- 'tma:<client_id>' (идемпотентность создания)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_holdings_user_key
  ON holdings(user_id, source_key) WHERE source_key IS NOT NULL;

-- Цели распределения по видам: enc1: str, JSON {"deposit":40,"crypto":25,...} (целые %, сумма 100); NULL — не заданы.
ALTER TABLE profiles ADD COLUMN invest_targets TEXT;
```

**`FIELDS` (`apps/api/src/db/crypto.ts`):**
`holdings: { name: 'str', ticker: 'str', quantity: 'str', avg_price: 'str', price: 'str', amount_minor: 'num', rate: 'num', note: 'str' }`,
в `profiles` добавить `invest_targets: 'str'`. Plaintext остаются только
`kind` (enum, нужен CHECK), `currency`, даты, `source_key` — как у `loans`.
Ни одного WHERE/ORDER BY/SUM по шифруемым колонкам: сортировка и агрегаты — в JS
(правило 19). `encryptBackfill` подхватит новую таблицу автоматически (итерирует
`FIELDS`) — проверить тестом.

**Количество и цена без float (ключевое решение).**
- `quantity`, `avg_price`, `price` хранятся как **каноническая десятичная
  строка** (не `toMinor`, не `num` — `decNum` делает `Number()` и потеряет
  точность): до 12 цифр целой части и до 8 дробных
  (`/^\d{1,12}(\.\d{1,8})?$/`, без ведущих нулей, без хвостовых нулей в дроби,
  `>0`). Цена тоже строкой — у мелких токенов цена < 0.01, `price_minor` дал бы 0.
- Арифметика — в новом `domain/decimal.ts` на **BigInt** (есть в Workers, не
  Node API): `parseDec(s) → {units: bigint, scale: 0..8}`,
  `formatDec`, `mulToMinor(qty, price) → number` = `round_half_up(qty × price × 100)`
  точно в BigInt, результат → `Number` с проверкой `≤ LIMITS.maxAmount*100`
  (иначе `DomainError('TOO_LARGE')`).
- Клиент (TMA) шлёт количество и цены **строками** в JSON (zod
  `z.string()`; запятая → точка, нормализация в домене). Числа JSON для этих
  полей отклоняются — иначе float потеряет 8-й знак.
- Стоимость позиции считается в minor units её валюты точно; перевод в базовую
  валюту — `convert()` (float, как во всём домене) с округлением до minor на
  границе (правило 11).

#### 3. Слои и файлы

| Слой | Файл | Что |
|---|---|---|
| Домен | `apps/api/src/domain/decimal.ts` (новый) | parse/format/compare/`mulToMinor` на BigInt |
| Домен | `apps/api/src/domain/portfolio.ts` (новый) | `holdingValueMinor(h)` (qty×price, иначе `amount_minor`); `pnlMinor(h)` (qty×(price−avg), null без avg); `depositAccrued(h, today)` — простые проценты `amount×rate×дни/365`, до `matures_on`; `portfolioTotals(items, fx, baseCcy)` → `{totalMinor, byKind, missing: string[]}` (позиции без курса исключаются и перечисляются); `allocation(byKind, targets)` → текущие % vs цели; `dcaTargetsFrom(targets | null)` → `null ⇒ {USD:1}` (поведение без изменений), иначе веса `pct/100` по видам; `validateTargets` (целые 0..100, сумма 100, ключи ⊂ видов) |
| Данные | `apps/api/migrations/0023_holdings.sql` | см. выше |
| Данные | `apps/api/src/db/crypto.ts` | `FIELDS.holdings`, `FIELDS.profiles.invest_targets` |
| Данные | `apps/api/src/db/scoped/types.ts` | `HoldingRow`, `invest_targets` в `ProfileRow` |
| Данные | `apps/api/src/db/scoped/holdings.ts` (новый, по образцу `loans.ts`) | `listHoldings()`, `getHolding(id)`, `addHolding(h)` (`INSERT OR IGNORE`, `source_key`), `findHoldingByKey(key)`, `countHoldings()`, `patchHolding(id, patch)` (`WHERE id=? AND user_id=?`, `updated_at`), `deleteHolding(id)` (`WHERE id=? AND user_id=?`). Все поля через `en(...)`, чтение через `decRow/decRows` |
| Данные | `apps/api/src/db/scoped/index.ts` | подключить `holdingsRepo(c)`; в `DataSources` — тип |
| Данные | `apps/api/src/db/scoped/profile.ts` | `invest_targets` в патче профиля (через `en`) |
| Данные | `apps/api/src/db/scoped/userdata.ts` | export: `holdings` (через `r.listHoldings()`, `strip` source_key), `schema_version: 7`; delete_me: `'holdings'` в список таблиц |
| Сервис | `apps/api/src/services/portfolio.ts` (новый) | `portfolioView(repo, profile, fxGet, today)`: читает позиции, собирает валюты, **толерантные курсы** — `getFxRates`; при `FxUnavailable(currency)` убирает эту валюту и повторяет (≤ числа валют), собирая `missing`; если недоступна сама базовая валюта — `total = null` + флаг; вызывает домен. Один источник для бота и TMA |
| Каскад | `apps/api/src/bot/features.ts:137`, `apps/api/src/tma/api.ts:93` | `dcaTargets: dcaTargetsFrom(p.invest_targets)`; бот: строка «DCA … → вклады $X · крипта $Y» при заданных целях; TMA `bonus.dca_split: [{kind, usd_minor}]` (пусто без целей) |
| Бот | `docs/ux/navigation.md` + `apps/api/src/bot/nav/screens.json` (СНАЧАЛА) | экран `INVEST` (kind `result`, depth 1, parent HOME, nav `[🏠 Меню]`, `/invest`); стрелка `HOME --> INVEST` в mermaid |
| Бот | `apps/api/src/bot/invest.ts` (новый) + регистрация `/invest` в `bot/commands.ts` и пункта HOME | рендер итога из `portfolioView`, нав-ряд через `navRow()`, дисклеймер, «редактирование — в приложении (кнопка у поля ввода)». `services/flows.ts` и `bot/profile.ts` в v1 **не трогаем** (мастер ввода в боте — только если владелец выберет, вопрос 2) |
| TMA API | `apps/api/src/tma/holdings.ts` (новый, по образцу `tma/debts.ts`) + подключение в `tma/api.ts` | маршруты ниже |
| TMA API | `apps/api/src/tma/profile.ts` | `invest_targets` в zod PATCH профиля |
| TMA API | `apps/api/src/tma/common.ts` | `LIMITS.maxHoldings = 50`, атом `zDec` |
| Web | `apps/web/src/screens/invest.tsx`, `invest-form.tsx` (новые), роутинг/вход с главной, api-клиент | список, итог, доли vs цели, форма (поля зависят от вида), `inputmode="decimal"`, значения строками, `client_id = crypto.randomUUID()`; цвета только токенами палитры; дисклеймер |

Household (правило 20): `householdSummary` и `services/household.ts` не
меняются; тест подтверждает, что партнёр не видит позиций и сумм.

#### 4. API (`/api/tma/*`, Bearer JWT, `tmaAuth`, `needProfile`, scoped(user.id))

| Метод | Путь | Тело / ответ | Ошибки |
|---|---|---|---|
| GET | `/api/tma/holdings` | → `{ items:[{id, kind, name, ticker, currency, quantity, avg_price, price, price_on, price_stale, amount_minor, rate, opened_on, matures_on, note, value_minor, pnl_minor, accrued_minor}], total:{currency, minor\|null, missing_rates:[ccy], fx_as_of, fx_stale}, allocation:{current:{kind:pct}, targets:{kind:pct}\|null}, disclaimer }` | 401, 403 `not_onboarded` |
| POST | `/api/tma/holdings` | `{client_id?, kind, name, ticker?, currency, quantity?, avg_price?, price?, price_on?, amount?, rate?, opened_on?, matures_on?, note?}` → 201 `{id}`; повтор `client_id` → 200 `{id, duplicate:true}` (`dupResult`) | 400 `validation`, 409 `limit` (>50), 409 `conflict` |
| PATCH | `/api/tma/holdings/:id` | частичный патч тех же полей → 200 `{ok:true}` | 400, 404 (чужой/нет — `changes=0`) |
| DELETE | `/api/tma/holdings/:id` | → 200 `{ok:true}` | 404 |
| PATCH | `/api/tma/profile` | `+ invest_targets: {kind:int}\|null` | 400 (сумма ≠ 100) |

Zod (`holdingSchema`, discriminated по `kind`):
- `name` 1..`maxName`, `ticker` `/^[A-Z0-9.\-]{1,12}$/` опц., `currency` — `zCcy`,
  `note` — `zNote`, даты — `zIso` + `dayInRange` для `price_on/opened_on`
  (`matures_on` может быть в будущем, но ≥ `opened_on`), `rate` 0..100.
- `zDec = z.string().trim().transform(',' → '.').refine(isCanonicalDec)` для
  `quantity/avg_price/price`; `amount` — `zAmount` (major) → `toMinor` на границе.
- `crypto|stock|bond`: обязательны `quantity` и `price`; `deposit|other`:
  обязателен `amount`; `quantity` для них запрещён (одна модель оценки на вид).
- `user_id` нигде не принимается; `id` — только из пути, предикат `user_id`.
- Сбой курсов — НЕ 503 на GET (толерантный режим, `missing_rates`); 503
  `fx_unavailable` только если совсем нет кэша и провайдера для базовой валюты
  и при этом есть позиции в другой валюте — тогда `total.minor = null`, список
  всё равно отдаётся (200).

Логи (правило 10): только коды ошибок и счётчики, никаких названий/сумм.

#### 5. Шаги реализации (после каждого — `npm run check`)

1. `domain/decimal.ts` + тесты (parse/format/mul/границы). Ничего не подключено.
2. `domain/portfolio.ts` + тесты (оценка, P&L, вклад, итоги с missing, цели, `dcaTargetsFrom`).
3. Миграция `0023_holdings.sql`; `FIELDS` в `crypto.ts`; типы в `scoped/types.ts`.
4. `db/scoped/holdings.ts` + подключение в `scoped/index.ts`; `invest_targets` в `scoped/profile.ts`. Тесты repo: шифрование at rest, «A не видит B», идемпотентность.
5. `userdata.ts`: export (schema_version 7) и delete_me. Тесты export/delete.
6. `services/portfolio.ts` (толерантные курсы) + тесты с фейковым FX-провайдером.
7. `tma/holdings.ts` + `LIMITS.maxHoldings`, `zDec` в `tma/common.ts`; подключение в `tma/api.ts`; `invest_targets` в `tma/profile.ts`. Тесты API.
8. Каскад: `dcaTargetsFrom` в `bot/features.ts:137` и `tma/api.ts:93`, `dca_split` в ответе плана. Существующие тесты плана зелёные без изменений (цели не заданы ⇒ `{USD:1}`).
9. Навигация: `docs/ux/navigation.md` (схема + строка реестра `INVEST`) и `screens.json`; затем `bot/invest.ts`, `/invest`, пункт HOME. `nav.test.ts` зелёный.
10. Web: `invest.tsx`, `invest-form.tsx`, роутинг, api-клиент, блок целей; тесты web (рендер, отправка строк, client_id).
11. Финал: `npm run check`, статус T3 → `[DOCS]`.

#### 6. Тесты

- **Домен (юнит, без golden — `golden.legacy.json` заморожен и не трогается):**
  `parseDec`: `'0.12345678'` ок, `'0,5'` → `'0.5'`, `'1e3'`/`'-1'`/`'0'`/`'0.123456789'`/`'NaN'` — ошибка;
  `mulToMinor('0.1','30000.5') = 300005`; `('0.00000001','1') = 0`; половина цента округляется вверх;
  `('999999999999','999999999999')` → `TOO_LARGE`; P&L с/без avg; `depositAccrued`
  с `today` параметром, обрезка по `matures_on`; `portfolioTotals` при отсутствии
  курса одной валюты — она в `missing`, итог по остальным; `dcaTargetsFrom(null)`
  = `{USD:1}`, `{deposit:60,crypto:40}` → веса 0.6/0.4 и `computeWaterfall` не бросает `TARGETS_SUM`.
- **Шифрование:** сырой `SELECT` (в тесте) по `holdings` — `name/quantity/price/avg_price/amount_minor/rate/note` начинаются с `enc1:`; `profiles.invest_targets` — тоже; `encryptBackfill` шифрует legacy-plaintext строку holdings.
- **«A не видит B»:** B создаёт позицию; A: GET не содержит её, PATCH/DELETE по её id → 404 и строка B не изменилась; repo-уровень `getHolding/patchHolding/deleteHolding` чужого id → null / `changes=0`.
- **Идемпотентность:** два POST с одним `client_id` → один ряд, второй ответ 200 `duplicate:true` с тем же id; один `client_id` у A и B — две независимые строки.
- **Fail-closed / auth:** без JWT и с битым JWT → 401; не onboarded → 403; JSON-число в `quantity` → 400; `user_id` в теле игнорируется (zod strip/strict).
- **Лимит:** 51-я позиция → 409 `limit`.
- **FX:** провайдер падает для одной валюты → 200, `missing_rates:['XXX']`, итог без неё; устаревший кэш → `fx_stale:true`.
- **Export/delete_me:** export содержит `holdings` без `source_key`, `schema_version: 7`; после `deleteAllUserData` строк holdings нет, чужие на месте.
- **Household:** партнёр через `householdSummary`/`/api/tma/household` не получает позиций и сумм портфеля.
- **Каскад:** без целей — ответ плана идентичен прежнему; с целями — `dca_split` по видам, сумма = `dca_usd_minor` (±1 minor).
- **Навигация:** `nav.test.ts` — `INVEST` в реестре и mermaid, нав-ряд `[🏠 Меню]`.
- **Web:** форма шлёт количество строкой, `client_id` один на попытку (повтор той же отправки — тот же id).

#### 7. Риски и откат

| Риск | Мера |
|---|---|
| Потеря точности количества/цены | строки + BigInt в домене, JSON-числа запрещены; тесты на 8-й знак |
| Валюта позиции без курса у провайдера (напр. `BTC`, `USDT` проходят `CCY_RE`) | толерантные курсы, пометка «нет курса», совет в форме: цена крипты — в USD; полноценно — T3b |
| Переполнение `Number` при огромных qty×price | проверка `TOO_LARGE` в домене до записи |
| Сортировка/агрегаты по шифртексту невозможны в SQL | всё в JS; ≤50 позиций — дёшево по CPU |
| Восприятие как совет | дисклеймер в боте и TMA; без рекомендаций «купить/продать» |
| Изменение каскада у существующих | без целей поведение байт-в-байт прежнее (`{USD:1}`) |
| Утечка партнёру | household-код не меняется, отдельный тест |
| Схема экспорта 7 ломает старые парсеры | экспорт только для чтения человеком/архива; версия поднята явно |

**Откат.** Миграции иммутабельны: `0023` не редактируется. Быстрый откат —
кодом (убрать маршруты/экран/пункт HOME, `dcaTargetsFrom` → `{USD:1}`); таблица
и колонка остаются пустыми/неиспользуемыми — безопасно. Если нужно убрать
схему — новая `0024_drop_holdings.sql` (`DROP TABLE holdings;`
`ALTER TABLE profiles DROP COLUMN invest_targets;`) — это удаление данных,
в боевом режиме только после «Да» владельца. Режим сейчас ТЕСТОВЫЙ, реальных данных нет.

#### 8. Затронутая документация (для `documenter`)

- `docs/ux/navigation.md` — экран `INVEST` (делает executor в шаге 9; documenter сверяет).
- `docs/ARCHITECTURE.md` — таблица `holdings`, колонка `profiles.invest_targets`, число таблиц, миграции 0001–0023, слой `services/portfolio.ts`.
- `AGENTS.md` — новое правило (21) «Инвестиции»: количество/цены — десятичные строки + BigInt, не `toMinor`; поля в `FIELDS`; партнёру не отдаются; без внешних цен до T3b.
- `docs/BACKLOG.md` — P1-9: этап 1 (T3a) сделан; T3b/T3c/T3d — открыты.
- `TASKS.md` — T3 → T3a `[DONE]`, строки T3b–T3d `[REVIEW]`.
- `README.md` — список возможностей (портфель, `/invest`); CHANGELOG, если ведётся.
- Описание формата `/export` (если где-то документирован) — `schema_version 7`, раздел `holdings`.

#### 9. Вопросы владельцу (простым языком; в скобках — что будет по умолчанию)

1. В какой валюте показывать общий итог портфеля? (По умолчанию — в валюте бюджета, как остальные суммы в приложении.)
2. Добавлять и править вложения — только в Mini App, а в боте лишь смотреть итог? (По умолчанию — да: в боте только итог, ввод в приложении; пошаговый ввод в боте — отдельной задачей.)
3. Должен ли партнёр по общему бюджету видеть ваши вложения? (По умолчанию — нет, ничего, даже общей суммы.)
4. Если вы зададите цели («40% вклады, 30% крипта…»), делить по ним часть премии, которая идёт на инвестиции? (По умолчанию — да; без целей всё как сейчас.)
5. Для вкладов показывать «≈ начислено» по простой формуле (без капитализации)? (По умолчанию — да, с пометкой «примерно».)

задачу можно переводить в `[READY]`

---

### План задачи: T3b Автоцены

Источник: `TASKS.md` T3b (разбор advisor), BACKLOG P1-9 (T3b). Продолжение T3a
(уже в проде: `holdings`, `domain/decimal.ts`, `domain/portfolio.ts`,
`services/portfolio.ts`, `tma/holdings.ts`, `bot/invest.ts`, `web/screens/invest*.tsx`).
Правила: AGENTS.md 2 (Workers ≠ Node), 3 (tenant), 4 (без токенов в URL), 6 (zod),
10 (логи), 16 (opt-in по образцу vision), 19 (шифрование), 21 (инвестиции).

#### 0. Что получится для пользователя

- В «Профиле → ⚡️ Возможности» Mini App появляется тумблер **«Автоцены крипты»**
  (по умолчанию выключен). В подсказке «ⓘ»: цены берутся у CoinGecko; наружу уходят
  только названия монет (bitcoin, ethereum…), без имени, сумм и количества.
- Когда тумблер включён, у позиций вида «Крипта» с известным тикером (BTC, ETH, SOL,
  USDT…) цена подставляется сама при открытии экрана «💼 Инвестиции» (и в боте `/invest`).
  Рядом пометка: «авто · 14:05» или «вручную · 01.11». Внизу экрана — «Цены крипты: CoinGecko».
- Ручная цена **не стирается**: если автоцены нет (сбой, нет ключа, монеты нет в
  списке, позиция в валюте, которую CoinGecko не знает) — показывается ручная, как
  сейчас, с пометкой «устарела», если ей больше 30 дней.
- У отдельной позиции автоцену можно выключить (галочка «Обновлять цену автоматически»
  в форме) — тогда для неё всегда ручная цена.
- Акции и облигации в T3b **остаются с ручной ценой** (см. §1 и вопрос 1).
- Дисклеймер «Это учёт, а не инвестиционная рекомендация» сохраняется.
- Если владелец не поставил ключ CoinGecko — тумблер виден, но неактивен с надписью
  «Автоцены пока не настроены»; ничего не ломается.

#### 1. Цель и границы; решение по провайдерам

> **Оговорка:** в этой сессии у architect не было инструмента веб-поиска, поэтому
> условия ниже — по состоянию знаний, а не свежей проверки. **Шаг 0 реализации**
> — сверка актуальных условий на официальных страницах (делает executor/advisor
> через веб-поиск до кода); при расхождении — назад в `[DESIGN]`.

| Класс | Источник | Решение в T3b | Почему |
|---|---|---|---|
| Крипта | **CoinGecko Demo API** (бесплатный ключ, `https://api.coingecko.com/api/v3/simple/price`, заголовок `x-cg-demo-api-key`) | **входит** | Бесплатный план с ключом; ориентир — ~30 запросов/мин и ~10 000/мес; пакетный запрос `ids=a,b,c&vs_currencies=usd,eur`; требуется атрибуция «Data by CoinGecko» (проверить в шаге 0) |
| Акции/фонды РФ, облигации РФ | MOEX ISS (без ключа, задержка ~15 мин) | **не входит → T3c** | Уже выделено в T3c; у ISS свои условия использования (свободный доступ с задержкой; перераспространение — по лицензии — проверить в T3c); доступность с IP Cloudflare проверить отдельно |
| Зарубежные акции/ETF | Yahoo Finance | **нет** | Условия Yahoo запрещают автоматический сбор; неофициальные «API» — нарушение и ломаются |
| Зарубежные акции/ETF | Finnhub / Alpha Vantage / Twelve Data / Tiingo (бесплатные ключи) | **не входит**, задел — интерфейс `PriceProvider` | Все требуют ключ; бесплатные планы — для личного некоммерческого использования; у Alpha Vantage очень мало запросов в сутки (порядка 25), у остальных — по одному запросу на тикер или малые пакеты. Честный вывод: «бесплатно, без ключа и законно» для зарубежных акций — нет. Если владелец захочет — отдельная задача (кандидат: Finnhub, ключ от владельца) |

**Входит:** общий кэш цен (миграция 0024), провайдер CoinGecko, фиксированный список
монет, opt-in флаг профиля + флаг позиции, «действующая цена» (авто/ручная) в
`portfolioView`, пометки в TMA и боте, атрибуция, тумблер, документация приватности.

**Не входит:** cron/фоновое обновление цен (цены — только при открытии экрана),
пуш-алерты по ценам, история цен/графики, произвольный поиск монет по CoinGecko
(`/search`), курсы крипты как валют позиции (позиция в валюте `BTC`/`USDT` — как в
T3a, «нет курса»), акции/облигации, запись автоцены в `holdings.price`.

#### 2. Данные — миграция `apps/api/migrations/0024_price_quotes.sql`

```sql
-- 0024_price_quotes.sql — автоцены портфеля (T3b).
-- Общий кэш котировок: НЕ пользовательские данные, без user_id (как fx_rates).
CREATE TABLE IF NOT EXISTS price_quotes (
  source      TEXT NOT NULL,       -- 'coingecko'
  asset_id    TEXT NOT NULL,       -- id монеты у провайдера: 'bitcoin' (только из белого списка)
  vs_currency TEXT NOT NULL,       -- 'USD', 'EUR'… (верхний регистр)
  price       TEXT NOT NULL,       -- каноническая десятичная строка (domain/decimal), не REAL
  as_of       TEXT NOT NULL,       -- ISO-время котировки у провайдера (last_updated_at)
  fetched_at  TEXT NOT NULL,       -- ISO-время нашего запроса (для TTL)
  PRIMARY KEY (source, asset_id, vs_currency)
);
-- Состояние провайдера: пауза после 429/5xx/401, чтобы не жечь лимит.
CREATE TABLE IF NOT EXISTS price_provider_state (
  source        TEXT PRIMARY KEY,
  blocked_until TEXT,              -- ISO; до этого момента внешних запросов нет
  last_status   INTEGER,           -- HTTP-код последнего сбоя (без тел ответа)
  updated_at    TEXT NOT NULL
);
-- Opt-in (правило 16 как образец): по умолчанию ничего наружу не уходит.
ALTER TABLE profiles ADD COLUMN auto_prices_enabled INTEGER NOT NULL DEFAULT 0;
-- Флаг позиции: 1 — брать автоцену, если есть; 0 — всегда ручная.
ALTER TABLE holdings ADD COLUMN auto_price INTEGER NOT NULL DEFAULT 1;
```

- **`FIELDS`:** изменений нет. `price_quotes`/`price_provider_state` — глобальные
  рыночные данные без связи с пользователем; `auto_prices_enabled`, `auto_price` —
  целочисленные флаги (как `vision_enabled`), не текст/деньги. Тикер позиции
  остаётся `enc1:`; id монеты выводится из тикера в JS после дешифровки и в
  `holdings` **не хранится** (новой шифруемой колонки нет).
- `UNIQUE(user_id, source_key)` не нужен — пользовательских вставок нет;
  идемпотентность кэша — PRIMARY KEY + `INSERT … ON CONFLICT DO UPDATE`.
- Индексы: PRIMARY KEY покрывает выборку `WHERE source=? AND vs_currency=? AND asset_id IN (…)`.
- Приватность кэша: в нём только id монет из белого списка, без user_id и времени
  «кто спросил»; связать строку кэша с пользователем нельзя.

#### 3. Ключевые решения

**3.1 Сопоставление тикера с монетой (однозначность).** Символы на CoinGecko не
уникальны (десятки токенов «ETH», «USDT» в разных сетях). Поэтому — **фиксированный
белый список** в `domain/coins.ts`: `COINS: Record<ticker, {id, name}>`, ~30
крупных монет: BTC→bitcoin, ETH→ethereum, USDT→tether, USDC→usd-coin,
BNB→binancecoin, SOL→solana, XRP→ripple, TON→the-open-network, TRX→tron,
DOGE→dogecoin, ADA→cardano, AVAX→avalanche-2, DOT→polkadot, LTC→litecoin,
LINK→chainlink, BCH→bitcoin-cash, XLM→stellar, ATOM→cosmos, NEAR→near,
MATIC/POL→polygon-ecosystem-token, DAI→dai, ETC→ethereum-classic, XMR→monero,
ARB→arbitrum, OP→optimism, APT→aptos, SUI→sui, SHIB→shiba-inu, UNI→uniswap,
WBTC→wrapped-bitcoin. **Каждый id сверить с CoinGecko `/coins/list` в шаге 0**
(они меняются, напр. MATIC→POL). Нет в списке → автоцены нет, в форме подсказка
«для этой монеты цена вручную». Произвольный id/поиск — не в T3b (вопрос 2).
Автоцена только для `kind='crypto'` (тикер «BTC» у акции не трогаем).

**3.2 Валюта котировки.** Запрашиваем `vs_currencies` = множество валют
крипто-позиций пользователя в нижнем регистре (обычно `usd`). Нет ключа валюты в
ответе (CoinGecko не знает, напр., `KGS`) → для таких позиций автоцены нет, пометка
«нет автоцены в KGS», ручная остаётся. Конвертация цены через FX **не делается**
(лишний float и запросы); подсказка в форме: «крипту удобнее вести в USD».

**3.3 Число провайдера → десятичная строка.** CoinGecko отдаёт JSON-число (float).
Единственная граница float: `decFromProviderNumber(n)` в `domain/decimal.ts` —
`Number.isFinite(n) && n > 0`, округление half-up до 8 знаков (через `toFixed(8)`
для n < 1e12, иначе отказ), снятие хвостовых нулей, проверка `isCanonicalDec`;
результат `'0'` (цена < 0.000000005) или > 12 цифр → `null` (котировки нет). Дальше —
только строки и BigInt (правило 21), `toMinor` не используется.

**3.4 Кэш, TTL, пакет, лимиты.**
- `TTL = 15 мин` (свежая — без запроса); котировка старше TTL — «просроченная», но
  пригодна как запасная до `QUOTE_MAX_AGE = 7 дней`; старше — не используется.
- Один пакетный запрос на провайдер на HTTP-запрос пользователя: только id, которых
  нет в кэше или они старше TTL, все сразу (`ids=…` ≤ 50 — потолок позиций), все
  нужные `vs_currencies`. Внешних запросов на один GET — **не больше 1**; D1 — чтение
  кэша одним `IN (…)` + запись одним `db.batch` + 1 чтение состояния провайдера.
- Расчёт лимитов: Workers Free — 50 внешних подзапросов на вызов (у нас +1),
  CPU 10 мс (разбор ≤50 котировок — пренебрежимо). CoinGecko ~10 000/мес: при
  TTL 15 мин один набор монет даёт ≤ 96 запросов/сутки ≈ 2 900/мес; для 2–5
  пользователей с пересекающимися монетами — с запасом. Cron не используется
  (никаких «цена × каждый пользователь» в тике — замечание advisor).
- Пауза при сбоях: `429` → `blocked_until = now + 10 мин`; `401/403` (ключ
  неверный/отозван) → `+ 6 ч`; `5xx`/таймаут (5 с, `AbortSignal.timeout`) →
  `+ 2 мин`. Во время паузы — только кэш. Гонка двух параллельных запросов
  допустима (upsert идемпотентен).

**3.5 Поведение при сбое и без ключа (fail-closed).**
- Нет `COINGECKO_API_KEY` в env → провайдер `null`: **ни одного** внешнего запроса,
  `auto.available=false`, всё работает на ручных ценах. Ключ передаётся только
  заголовком, не в URL (правило 4 по духу; не попадает в логи URL).
- Сбой/пауза/кривой ответ (zod не прошёл) → котировки из кэша ≤ 7 дней с пометкой
  «авто, обновлено N ч назад»; нет и их → ручная цена (+ «устарела» по T3a).
  GET `/api/tma/holdings` **никогда** не отдаёт 5xx из-за цен.
- Профиль `auto_prices_enabled=0` → провайдер не вызывается, кэш не читается.
- Логи (правило 10): только `price_fetch_failed` + HTTP-код и число id; никаких
  тикеров/id монет, ключа, тел ответов.

**3.6 Авто vs ручная цена (приоритет).** Чистая функция
`effectivePrice(h, quote | null, today, nowIso)` в `domain/portfolio.ts`:
1. Автоцена применима: профиль вкл, `h.auto_price=1`, `kind='crypto'`, тикер в
   списке, есть котировка ≤ 7 дней.
2. Свежая автоцена (≤ 24 ч) **побеждает** ручную.
3. Автоцена 1–7 дней: берётся более свежая из двух (сравнение даты котировки и `price_on`).
4. Иначе — ручная (как в T3a).
Результат: `{price, on, source: 'auto'|'manual', stale}`; `holdingValueMinor`/`pnlMinor`
считаются от действующей цены. **`holdings.price/price_on` автоценой не
перезаписываются** — ручная цена всегда сохранена и видна в форме. Позиция без
ручной цены создаваться может только как раньше (T3a требует `price` для crypto) —
не меняем: ручная цена — страховка.

#### 4. Слои и файлы

| Слой | Файл | Что |
|---|---|---|
| Домен | `apps/api/src/domain/coins.ts` (новый) | `COINS` белый список, `coinIdFor(kind, ticker) → string \| null` |
| Домен | `apps/api/src/domain/decimal.ts` | `decFromProviderNumber(n) → string \| null` |
| Домен | `apps/api/src/domain/portfolio.ts` | `effectivePrice(...)`, константы `AUTO_FRESH_HOURS=24`, `QUOTE_MAX_AGE_DAYS=7`; `HoldingLike.auto_price` |
| Данные | `apps/api/migrations/0024_price_quotes.sql` | см. §2 |
| Данные | `apps/api/src/db/repo.ts` (рядом с `fxRepo`, глобальный, не scoped) | `priceRepo(db)`: `getMany(source, vs[], ids[])` (один SELECT `IN`), `upsertMany(rows)` (`db.batch`, ON CONFLICT), `getState(source)`, `setState(source, blockedUntil, status, now)` |
| Данные | `apps/api/src/db/scoped/types.ts` | `HoldingRow.auto_price`, `ProfileRow.auto_prices_enabled` |
| Данные | `apps/api/src/db/scoped/holdings.ts` | `auto_price` в `addHolding`/`patchHolding` (plaintext int) |
| Данные | `apps/api/src/db/scoped/profile.ts` | `auto_prices_enabled` в патче и в списке флагов |
| Данные | `apps/api/src/db/scoped/userdata.ts` | export: `auto_price` в holdings, флаг в профиле → `schema_version: 8`; delete_me — без изменений (кэш общий, не данные пользователя) |
| Внешнее | `apps/api/src/prices/provider.ts` (новый) | `interface PriceProvider { source; latest(ids[], vs[]): Promise<{quotes: {id, vs, price, asOf}[]}> }`, `class PriceUnavailable(status?)` |
| Внешнее | `apps/api/src/prices/coingecko.ts` (новый) | `createCoinGecko(apiKey, fetchImpl=fetch)`: `GET /simple/price?ids=…&vs_currencies=…&include_last_updated_at=true`, заголовок `x-cg-demo-api-key`, таймаут 5 с, zod `record(record(number))`, только Web API (`fetch`, `URLSearchParams`) |
| Внешнее | `apps/api/src/prices/service.ts` (новый) | `getQuotes(db, provider \| null, refs: {id, vs}[], now) → {map, fetchedAt, stale, failed}`: кэш → пакет только по нужным → upsert → при сбое запасной кэш ≤7 дн + `setState` паузы |
| Сервис | `apps/api/src/services/portfolio.ts` | `portfolioView(repo, p, fxGet, today, quotesGet?)`: при `p.auto_prices_enabled=1` и провайдере — собрать refs по позициям (`coinIdFor`), один `getQuotes`, затем `effectivePrice` для каждой; `HoldingItem` += `price_source`, `effective_price`, `effective_price_on`, `auto_supported`, `auto_note` (`'no_quote' \| 'ccy_unsupported' \| null`); `PortfolioView` += `auto: {enabled, available, as_of, stale, attribution}` |
| Wiring | `apps/api/src/env.ts` | `COINGECKO_API_KEY?: string` (секрет) |
| Wiring | `apps/api/src/http/router.ts` | `deps.prices?: PriceProvider \| null` (для тестов); по умолчанию `env.COINGECKO_API_KEY ? createCoinGecko(key) : null`; передать в `registerTmaHoldings` и в бот `/invest` |
| TMA API | `apps/api/src/tma/holdings.ts` | `auto_price: z.boolean().optional()` в create/patch; GET отдаёт новые поля + `auto.supported_tickers` (из `COINS`, для подсказки формы) |
| TMA API | `apps/api/src/tma/profile.ts` | `auto_prices_enabled: z.boolean().optional()` в PATCH; GET профиля += `auto_prices_enabled`, `auto_prices_available` (`!!env.COINGECKO_API_KEY`) |
| Бот | `apps/api/src/bot/invest.ts` | пометки «авто/вручную», строка «Цены крипты: CoinGecko»; экранов не добавляем → `navigation.md`/`screens.json` **без изменений** (проверить `nav.test.ts`) |
| Web | `apps/web/src/api.ts`, `screens/profile-toggles.tsx` | `ToggleKey += 'auto_prices_enabled'`; запись в `FEATURES` с `Info` (CoinGecko, что уходит наружу); неактивен при `auto_prices_available=false` |
| Web | `apps/web/src/screens/invest.tsx`, `invest-form.tsx` | бейдж «авто · ЧЧ:ММ» / «вручную · дата» / «устарела» (токены палитры), строка атрибуции; в форме для crypto — галочка «Обновлять цену автоматически» (видна, если тикер в `supported_tickers`), поле ручной цены остаётся |
| Web | `apps/web/src/demo/mock.ts`, `demo/tw.tsx` | новые поля в моках |

Household (правило 20): `householdSummary` не меняется; партнёр не видит ни позиций,
ни флагов, ни котировок по ним.

#### 5. API (`/api/tma/*`, Bearer JWT, scoped(user.id), `user_id` не принимается)

| Метод | Путь | Изменение | Ошибки |
|---|---|---|---|
| GET | `/api/tma/holdings` | items += `price_source`, `effective_price`, `effective_price_on`, `auto_supported`, `auto_note`; `value_minor/pnl_minor/price_stale` — от действующей цены; `price/price_on` — ручные (для формы); корень += `auto:{enabled, available, as_of, stale, attribution, supported_tickers}` | 401, 403; сбой цен → **200** с ручными ценами |
| POST | `/api/tma/holdings` | `+ auto_price?: boolean` (по умолчанию true); `client_id` — как в T3a | 400 |
| PATCH | `/api/tma/holdings/:id` | `+ auto_price?: boolean` | 400, 404 (чужой id) |
| GET/PATCH | `/api/tma/profile` | `+ auto_prices_enabled` (boolean в PATCH; 0/1 в GET), GET `+ auto_prices_available` | 400 |

Включение тумблера без ключа — разрешено (сохраняется), но цены не тянутся;
ответ `auto.available=false`. Новых кодов ошибок нет.

#### 6. Шаги реализации (после каждого — `npm run check`)

0. **Сверка условий (веб-поиск, без кода):** CoinGecko Demo — лимиты, атрибуция,
   допустимость использования в личном боте, формат `/simple/price` и заголовок
   ключа; id монет из `COINS` по `/coins/list`. Итог — в комментарий `prices/coingecko.ts`
   и `domain/coins.ts`. Расхождение с планом → назад в `[DESIGN]`.
1. `domain/coins.ts` + `decFromProviderNumber` + `effectivePrice` и тесты.
2. Миграция `0024_price_quotes.sql`; типы в `scoped/types.ts`; `auto_price` в
   `scoped/holdings.ts`, `auto_prices_enabled` в `scoped/profile.ts`; `priceRepo` в `repo.ts`.
3. `prices/provider.ts`, `prices/coingecko.ts` (с инъекцией `fetchImpl`) + тесты на фейковом fetch.
4. `prices/service.ts` (кэш/TTL/пакет/пауза/запасной кэш) + тесты.
5. `services/portfolio.ts` — действующая цена; `env.ts`, `router.ts` (deps); тесты сервиса.
6. `tma/holdings.ts`, `tma/profile.ts` + тесты API.
7. `bot/invest.ts` — пометки; `nav.test.ts` зелёный без правок реестра.
8. `userdata.ts` — export `schema_version: 8`; тест.
9. Web: `api.ts`, `profile-toggles.tsx`, `invest.tsx`, `invest-form.tsx`, моки; тесты web.
10. `apps/api/.dev.vars.example` — строка `COINGECKO_API_KEY=` (пустая). Финал:
    `npm run check`, T3b → `[DOCS]`. Ключ ставит владелец (§7), без ключа выкладка безопасна.

#### 7. Ключ — только владелец

Инструкция владельцу (executor выдаёт в конце): 1) зарегистрироваться на
coingecko.com → Developer Dashboard → создать бесплатный Demo-ключ; 2) в папке
проекта: `npm run wrangler -- secret put COINGECKO_API_KEY` и вставить ключ
(для стейджинга — `--env staging`); 3) открыть «💼 Инвестиции» и включить тумблер.
Claude ключ не видит и не хранит; в git/`.dev.vars` не попадает.

#### 8. Тесты

- **Домен:** `coinIdFor('crypto','btc'→'BTC') = 'bitcoin'`, `('stock','BTC') = null`,
  неизвестный тикер → null; `decFromProviderNumber`: `64123.456789123 → '64123.45678912'`,
  `1.2e-5 → '0.000012'`, `1e-10 → null`, `NaN/-1/0/Infinity/1e13 → null`, half-up на 8-м
  знаке; `effectivePrice`: свежая авто бьёт ручную; авто 3 дня vs ручная вчера → ручная;
  авто 3 дня vs ручная 40 дней → авто; авто 8 дней → ручная; `auto_price=0` → ручная;
  профиль выкл → ручная; `today`/`now` — параметры.
- **Провайдер (фейковый fetch):** ключ в заголовке, **не** в URL; ids и vs пакетом
  одним вызовом; таймаут/HTTP 500/429/401 → `PriceUnavailable(status)`; кривой JSON → то же.
- **Сервис цен:** свежий кэш → 0 вызовов fetch; часть просрочена → 1 вызов только по
  просроченным; сбой → запасной кэш ≤7 дн и `stale:true`; 429 → пауза, повторный
  запрос в паузе → 0 вызовов; `provider=null` (нет ключа) → 0 вызовов, пустая карта.
- **Изоляция («A не видит B»):** A (BTC) и B (SOL), оба вкл. GET A — ни одной
  позиции/цены B; запрос провайдеру от A содержит только `bitcoin`; в `price_quotes`
  нет колонки `user_id` (PRAGMA table_info); PATCH `auto_price` по id позиции B от A → 404,
  строка B не изменилась. A выкл, B вкл → GET A: 0 вызовов fetch.
- **Fail-closed:** без ключа → 200, все `price_source:'manual'`, `auto.available=false`,
  fetch не вызван; провайдер падает → 200, никаких 5xx; без JWT → 401.
- **Логи (правило 10):** перехват `console.*` при сбое провайдера — нет тикеров/id монет,
  ключа, тела ответа; есть только код.
- **Ручная цена не теряется:** после GET с автоценой сырой `SELECT price` позиции
  — прежний `enc1:` (тот же расшифрованный текст), `price_on` не изменился.
- **Export:** `schema_version: 8`, `auto_price` в holdings, `auto_prices_enabled` в профиле.
- **Household:** `householdSummary` не содержит котировок/флагов портфеля.
- **Web:** тумблер шлёт `auto_prices_enabled: true`; неактивен при `available=false`;
  бейдж «авто/вручную»; галочка в форме видна только для тикера из списка.

#### 9. Риски и откат

| Риск | Мера |
|---|---|
| Смена условий/лимитов CoinGecko, отзыв ключа | шаг 0 сверки; пауза при 401/403/429; без цен всё работает на ручных |
| Неоднозначный тикер (другая монета с тем же символом) | только белый список, только `kind='crypto'` |
| Потеря точности (float из JSON) | одна граница `decFromProviderNumber`, дальше строки + BigInt |
| Перерасход лимитов Workers Free / CoinGecko | ≤1 внешний запрос на GET, TTL 15 мин, без cron |
| Утечка состава портфеля | наружу только id монет без идентификаторов; кэш без user_id; opt-in DEFAULT 0; пометка в подсказке и SECURITY.md |
| Медленный провайдер тормозит экран | таймаут 5 с, затем кэш/ручная |
| Пользователь думает, что цена «биржевая и точная» | пометка времени котировки, атрибуция, дисклеймер |

**Откат.** Мгновенный, без кода: владелец удаляет секрет
(`npm run wrangler -- secret delete COINGECKO_API_KEY`) — внешние запросы
прекращаются, все цены ручные. Кодом — `portfolioView` перестаёт вызывать
`getQuotes`. Миграция `0024` не редактируется; если нужно убрать схему — новая
`0025_drop_price_quotes.sql` (`DROP TABLE price_quotes; DROP TABLE price_provider_state;`
`ALTER TABLE profiles DROP COLUMN auto_prices_enabled; ALTER TABLE holdings DROP COLUMN auto_price;`).
Кэш котировок — не данные пользователей; флаги — да (в боевом режиме — по «Да» владельца).

#### 10. Затронутая документация (для `documenter`)

- `AGENTS.md` — правило 21: «внешних источников цен пока нет» → автоцены крипты
  (CoinGecko, opt-in `auto_prices_enabled`, флаг `holdings.auto_price`, общий кэш
  `price_quotes` без user_id, TTL 15 мин, приоритет авто/ручной, ручная не
  перезаписывается, белый список `domain/coins.ts`, ключ `COINGECKO_API_KEY`).
- `docs/ARCHITECTURE.md` — таблицы `price_quotes`, `price_provider_state`, колонки
  0024, миграции 0001–0024, слой `prices/` в «Внешнее».
- `SECURITY.md` — строка «Названия монет → CoinGecko (opt-in)».
- `apps/api/.dev.vars.example`, `.env.example` (если там перечислены секреты),
  `docs/v2-development.md` (секреты, стейджинг), `README.md` (возможности), `CHANGELOG.md`.
- `docs/BACKLOG.md` P1-9 и `TASKS.md` — T3b закрыта; зарубежные акции — отдельная идея (если владелец захочет).
- Формат `/export` — `schema_version 8`.

#### 11. Вопросы владельцу (простым языком; в скобках — по умолчанию)

1. Делаем сейчас автоцены только для крипты, а российские акции и облигации — следующей задачей (Мосбиржа)? Для зарубежных акций бесплатного источника без ключа нет. (По умолчанию — да, только крипта.)
2. Автоцены только для ~30 популярных монет (BTC, ETH, USDT, SOL, TON…), остальные — вручную? (По умолчанию — да: так не перепутаем монеты с одинаковым названием.)
3. Обновлять цены не чаще раза в 15 минут и только когда вы открываете экран, без фоновой работы? (По умолчанию — да.)
4. Если автоцена свежая (до суток), показывать её вместо ручной, а ручную хранить как запасную? (По умолчанию — да.)
5. Готовы сами получить бесплатный ключ CoinGecko и вставить его по инструкции из 3 шагов? Без ключа всё работает, просто цены остаются ручными. (По умолчанию — да, после выкладки.)

задачу можно переводить в `[READY]`

---

## T10 Форма позиции: потрачено

Схема владельца: пользователь вводит количество и «потрачено всего» (сколько заплатил за всё количество); остальное считает система. Ручная цена для крипты с автоценой не нужна.

- Миграция `0025_holdings_invested.sql`: `holdings.invested TEXT` (десятичная строка, валюта позиции); `invested` — в `FIELDS` (`db/crypto.ts`, правила 19/21); экспорт `schema_version 9`. Старые строки не бэкфиллятся: пустой `invested` заменяется в JS на `quantity × avg_price` (`investedMinor`, BigInt). `avg_price` остаётся в БД/API, из UI убирается.
- API (`tma/holdings.ts`): для crypto/stock/bond принимается `invested` (zDec, необяз.); `price` обязательна, кроме крипты с тикером из `domain/coins.ts`. Лимиты и изоляция прежние.
- Оценка (`domain/portfolio.ts`: `investedMinor`, `pnlMinor`, `valuation`; `services/portfolio.ts`): P&L = стоимость сейчас − invested. Нет ни авто-, ни ручной цены — оценка по invested, P&L 0, `valued_at_cost: true`, позиция входит в итог. `effectivePrice` не меняется.
- Mini App (`invest-form.tsx`, `invest-common.ts`, `invest.tsx`, `api.ts`): поля Название, Валюта, Тикер, Количество, «Потрачено всего», «Цена сейчас» — только если автоцены нет (по `supported_tickers`); галочка автообновления убрана (`auto_price` = true по умолчанию). Карточка: «Крипта · 0.002 BTC · потрачено 128 USD» + «авто · время» / «по цене покупки». Бот `/invest` — строка о позициях без цены.
- Тесты: домен, API (BTC без price, 400 для акции без price, шифрование invested, A не видит B), web `invest-common`.

---

### План задачи: T3c Автоцены MOEX

Источник: `TASKS.md` T3c, BACKLOG P1-9 (T3c). Продолжение T3b/T10 (в проде:
`prices/provider.ts`, `prices/coingecko.ts`, `prices/service.ts`, `domain/coins.ts`,
кэш `price_quotes`, `price_provider_state`, `effectivePrice`, форма с `TickerField`/`needsPrice`).
Правила: AGENTS.md 2, 3, 4, 6, 10, 11, 16, 19, 20, 21. Кыргызские биржи **не рассматриваются**.

> **Оговорка.** Факты об ISS даны владельцем (проверены им вживую) и по знаниям architect;
> веб-доступа у architect не было. **Шаг 0** — сверка по https://iss.moex.com/iss/reference
> и живым ответам ISS (список ниже, п. 3.9). Расхождение, ломающее план, → назад в `[DESIGN]`.

> **Итог шага 0 (живые запросы к ISS, 2026-11-18, среда, торги идут).**
> (a) Облигации: `LAST/MARKETPRICE/PREVPRICE` — **% к номиналу** (ОФЗ 26238 — 51.058; описание
> столбца «% к номиналу»), `FACEVALUE` — непогашенный номинал (бывает 1000, 100, 74.98),
> `ACCRUEDINT` — НКД в деньгах «в валюте расчётов», `FACEUNIT` — валюта номинала. Формула плана
> подтверждена. (b) `securities=A,B` на уровне рынка (без борда) **работает**, `BOARDID`
> возвращается, несуществующий SECID → пустые массивы (не ошибка), 21 код в одном запросе прошёл
> (лимит не найден; оставляем пакет 10 из-за длины URL). У одной бумаги бывает несколько
> бордов с разной валютой (SBCN: TQBR RUB, TQTY CNY) — белый список бордов обязателен.
> (c) **Расхождение:** `SYSTIME` = текущее серверное московское время (12:18:06 при
> UPDATETIME 12:03:06), а не время котировки; время котировки = `UPDATETIME` (чч:мм:сс, без
> даты, задержка 15 мин). Решение: время котировки = дата из `SYSTIME` + `UPDATETIME`; если
> получилось позже `SYSTIME` — минус сутки. (Поведение на выходных не проверено — сегодня
> среда; худший случай — дата выходного дня при пятничном времени, в пределах 96 ч свежести.)
> `PREVPRICE`+`PREVDATE` (18:50) — запасной вариант. Столбца `TRADEDATE` в marketdata нет.
> (d) Поиск `/iss/securities.json?q=` работает с `engine=stock&market=shares|bonds&is_trading=1&limit`,
> регистр не важен, кириллица (url-encoded) работает, `q` из 1 символа даёт пустой ответ
> (минимум 2); находит и по ISIN; `group`: `stock_shares`, `stock_ppif` (БПИФ), `stock_bonds`;
> без `market` лезут индексы (`INPF`, `INAV`) — фильтр по `primary_boardid` обязателен.
> (e) Борды облигаций с торгами: `TQOB, TQCB, TQOD, TQOY` (+ `TQIR` формально без торгов,
> оставляем); юаневые — `TQOY` (CNY). Акции/фонды: `TQBR, TQTF, TQIF`. (f) Доступность с IP
> Cloudflare живым запросом не проверена (нет деплоя) — fail-closed уже предусмотрен. (g) Текст
> «Порядка использования биржевой информации» не открывался; оговорка о личном использовании
> остаётся комментарием в `prices/moex.ts`.

#### 0. Что получится для пользователя

- Тумблер в «Профиле → ⚡️ Возможности» переименовывается в **«Автоцены»** (один на крипту и
  биржу, см. 3.7 и вопрос 1). В «ⓘ»: крипта — CoinGecko, акции и облигации — Московская
  биржа (данные с задержкой 15 минут); наружу уходят только тикеры/коды бумаг, без имени,
  сумм и количества.
- В форме позиции вида **«Акция»** (сюда же фонды/БПИФ) и **«Облигация»** поле тикера
  становится поиском по Мосбирже: вводишь «сбер» / «SBER» / ISIN («RU000A…», «SU26238RMFS4») —
  появляется список до 10 бумаг «SBER · Сбербанк ао · RUB», выбираешь — подставляются тикер,
  название (если пусто) и валюта (RUB, у юаневых облигаций — CNY). Можно ввести тикер
  вручную («Другое…»), как у крипты.
- «Цена сейчас» для акции/облигации с тикером **не обязательна**: цену ведёт биржа. Если
  биржа цену не дала (бумага не найдена, нет торгов, тумблер выключен) — позиция оценивается
  «по цене покупки» (как T10), с понятной пометкой; ручную цену можно ввести всегда.
- Карточка: «Акция · 10 шт SBER · потрачено 2 900 ₽» + «биржа · 14:05» (или «биржа · пт 18:49»
  в выходные). Облигация: цена за 1 шт в рублях **с НКД** (подпись «с НКД», см. 3.4).
- Внизу экрана — «Цены акций и облигаций: Московская биржа, задержка 15 мин» рядом с
  атрибуцией CoinGecko. В боте `/invest` — те же пометки и строка источника.
- Количество — **в штуках, не в лотах** (подсказка в форме).

#### 1. Цель и границы

**Входит:** провайдер MOEX ISS (без ключа), сопоставление тикера/ISIN с бумагой через
поиск ISS, выбор борда по белому списку, пересчёт цены облигации (% × номинал / 100 + НКД),
обобщение `prices/service.ts` и `effectivePrice` на несколько источников, эндпоинт поиска
для формы, пометки и атрибуция в Mini App и боте, «цена не обязательна» для stock/bond с тикером.

**Не входит:** кыргызские и любые иностранные биржи; срочный и валютный рынки MOEX;
внебиржевые бумаги; купоны/погашения/амортизация как события (T3d); журнал сделок (T3d);
cron/фоновое обновление и пуши; хранение истории цен; перевод цены бумаги в другую валюту
позиции (см. 3.5); коммерческое распространение данных биржи.

#### 2. Данные — миграции нет

Новая миграция **не нужна** (при выборе по умолчанию в вопросе 1):
- котировки MOEX ложатся в существующий `price_quotes`: `source='moex'`, `asset_id` = SECID
  бумаги (`SBER`, `SU26238RMFS4`, `RU000A105SK3`), `vs_currency` = валюта цены за штуку
  (`RUB`/`CNY`), `price` — каноническая десятичная строка **цены за 1 шт** (для облигации —
  уже пересчитанная, с НКД), `as_of` — время самой котировки (см. 3.3), `fetched_at` — наше;
- пауза — существующий `price_provider_state` (строка `source='moex'`);
- SECID хранится в уже шифруемом `holdings.ticker` (`enc1:`, `FIELDS` без изменений); борд
  **не хранится** — выбирается при запросе по белому списку (3.1); новых пользовательских
  колонок нет → `FIELDS`, экспорт (`schema_version` остаётся 9) и `delete_me` без изменений;
- `UNIQUE(user_id, source_key)` не нужен — пользовательских вставок нет (кэш — PK + upsert).

Если владелец выберет **отдельный тумблер** (вопрос 1, вариант «Нет»): миграция
`0026_moex_prices_flag.sql` — `ALTER TABLE profiles ADD COLUMN moex_prices_enabled INTEGER NOT NULL DEFAULT 0;`
(флаг, не в `FIELDS`; экспорт → `schema_version 10`).

#### 3. Ключевые решения

**3.1 Тикер → бумага → борд (однозначно).** SECID на Мосбирже уникален (в отличие от
символов крипты), поэтому белый список бумаг не нужен — нужен белый список **бордов**
(режимов торгов) и порядок приоритета, константы в новом `domain/moex.ts`:
- `stock` → рынок `shares`, борды `['TQBR', 'TQTF']` (акции, затем фонды/БПИФ);
- `bond` → рынок `bonds`, борды `['TQOB', 'TQCB', 'TQIR']` (ОФЗ, корпоративные, ПИР) —
  состав (в т.ч. `TQOD`/`TQOY` для валютных/юаневых выпусков) уточнить в шаге 0.
Котировка: **один запрос на рынок** без указания борда —
`GET /iss/engines/stock/markets/{shares|bonds}/securities.json?securities=A,B,…&iss.meta=off&iss.only=securities,marketdata`
со столбцами `securities.columns=SECID,BOARDID,SHORTNAME,CURRENCYID,FACEUNIT,FACEVALUE,ACCRUEDINT,PREVPRICE,PREVDATE`
и `marketdata.columns=SECID,BOARDID,LAST,LCURRENTPRICE,MARKETPRICE,SYSTIME`; строки соединяются
по `(SECID, BOARDID)`, из бордов белого списка берётся первый по приоритету, где есть цена
(3.3). Бумага, найденная только на чужих бордах (SPEQ, SMAL, внебиржевые), → котировки нет.
Если шаг 0 покажет, что запрос без борда не отдаёт `BOARDID` или фильтр `securities` не
работает на уровне рынка — запасной вариант: запрос на каждый борд из списка (≤ 5 запросов).
Пакет `securities=` — до 10 SECID на запрос (лимит длины списка проверить в шаге 0; при
меньшем лимите — дробить).
**ISIN и поиск** — эндпоинт формы (§5) проксирует `GET /iss/securities.json?q=<строка>&engine=stock&market=<shares|bonds>&is_trading=1&limit=10&iss.meta=off&iss.only=securities&securities.columns=secid,isin,shortname,name,primary_boardid,group`;
результаты фильтруются по `primary_boardid` ∈ белому списку, в позицию сохраняется **SECID**
(у ОФЗ SECID ≠ ISIN, поэтому ISIN как ключ не храним). Валюта для выбранных бумаг — вторым
запросом к рынку (`CURRENCYID`/`FACEUNIT`, SUR → RUB). Итого ≤ 2 внешних запроса на поиск.
Сопоставление «вид ↔ рынок» жёсткое: SECID облигации у позиции вида «Акция» котировки не
получит (`auto_note: 'not_found'`); форма выставляет вид по `group` из поиска.

**3.2 Акции: цена.** `LAST` (рубли за 1 шт, не за лот). `CURRENCYID 'SUR'` → `RUB`
(функция `moexCcy`: SUR→RUB, остальное — как есть, проверка `CCY_RE`).

**3.3 Какая цена и какое время (нет торгов, null).** Порядок для строки борда:
`LAST` → `LCURRENTPRICE` → `MARKETPRICE` (время — `SYSTIME`) → `PREVPRICE` из блока
securities (время — `PREVDATE` 18:50 МСК). Всё null или ≤ 0 → котировки для бумаги нет
(не ошибка запроса). `SYSTIME`/`PREVDATE` — московское время; Москва без перехода на
летнее время, поэтому чистая функция `mskToIso('YYYY-MM-DD HH:MM:SS') = …-03:00 → UTC ISO`.
Время котировки — **её собственное** (на выходных — пятничное), а не время нашего запроса:
пользователь видит «биржа · пт 18:49». В шаге 0 проверить, что на выходных `SYSTIME` не
равен «сейчас» при старом `LAST`; если равен — время брать из `PREVDATE`/`UPDATETIME`.

**3.4 Облигации: % × номинал + НКД (решение — с НКД).** `LAST/MARKETPRICE/PREVPRICE` у
облигаций — **в процентах от номинала** (проверить в шаге 0 по описанию столбцов
`/iss/engines/stock/markets/bonds/securities/columns.json`). `FACEVALUE` — текущий
(непогашенный) номинал в валюте `FACEUNIT`; `ACCRUEDINT` — НКД **в деньгах** за 1 шт в той же
валюте. Цена за 1 шт = `pct × FACEVALUE / 100 + ACCRUEDINT` — чистая функция
`bondUnitPrice(pct, face, aci)` в `domain/moex.ts` на BigInt (`decimal.ts`: новые `mulDec`,
`addDec`, деление на 100 — сдвиг масштаба, округление half-up до 8 знаков); числа из JSON —
только через существующий `decFromProviderNumber`. Валюта котировки облигации — `FACEUNIT`
(SUR→RUB; `CNY` у юаневых). **Почему с НКД:** «потрачено всего», которое вводит пользователь,
включает уплаченный НКД; без НКД результат «+/−» систематически занижен. Честная оговорка
(подпись в «ⓘ»): после выплаты купона НКД обнуляется и стоимость «проседает» — купоны
появятся в T3d. Нет `FACEVALUE` → котировки нет; нет `ACCRUEDINT` → считаем 0.

**3.5 Валюта котировки и getFxRates.** Котировка MOEX — в «родной» валюте бумаги
(RUB, у юаневых облигаций — CNY). Цена **не конвертируется** в другую валюту позиции (float
на цене нарушил бы правило 21): форма ставит валюту из поиска; если валюта позиции ≠ валюте
котировки → автоцены нет, `auto_note: 'ccy_mismatch'` («смените валюту позиции на RUB»).
Пересчёт в валюту бюджета — как всегда, через `getFxRates` в `tolerantRates`
(`services/portfolio.ts`, правило 11); нет курса RUB/CNY → позиция видна, в итог не входит,
код в `missing_rates`.
Для этого провайдер объявляет `quoteCurrency: 'native'` (CoinGecko — `'requested'`): в
`prices/service.ts` для native-провайдеров ключ кэша/карты — по `asset_id` (любой `vs`),
`AutoQuote` получает поле `vs`, а сравнение с валютой позиции делает `portfolioView`.
Это убирает вечный повторный запрос при несовпадении валют. Новый метод
`priceRepo.getByIds(source, ids)` (один `SELECT … WHERE source=? AND asset_id IN (…)`).

**3.6 Кэш, TTL, лимиты.** TTL **15 мин** круглосуточно (данные и так с задержкой 15 мин;
вне торгов повторный запрос дешёвый и вернёт ту же последнюю цену с её датой — отдельное
расписание биржи не моделируем: сессии менялись — вечерняя, выходные дни, — а ошибка в
календаре хуже лишнего запроса). Запасной кэш при сбое — до **14 дней** (новогодние
праздники длиннее 7). Свежесть для `effectivePrice` у MOEX — `freshHours = 96` (выходные +
праздник), `maxAgeDays = 14`; у CoinGecko прежние 24 ч / 7 дней. Параметры — у провайдера
(`ttlMs`, `fallbackMaxAgeDays`) и в политике `effectivePrice` (3.8).
Лимиты Workers Free (50 подзапросов на вызов): один GET портфеля = CoinGecko ≤ 1 +
MOEX ≤ 2 рынка × ⌈N/10⌉ (N ≤ 50 позиций → худший случай 10, обычно 1–2) + FX по числу валют
(обычно 1–3) ⇒ ≤ ~15. Поиск — ≤ 2. CPU: столбцы урезаны `*.columns`, ответ ≤ 10 бумаг —
разбор пренебрежим. Без cron. ISS без ключа и явных квот; пауза при 429 всё равно действует.

**3.7 Opt-in: один общий тумблер (предложение по умолчанию).** Используем существующий
`profiles.auto_prices_enabled` (DEFAULT 0), переименованный в UI в «Автоцены», с перечнем
источников в «ⓘ». Обоснование: наружу уходит данные одного рода (только коды инструментов,
без сумм и личности), пользователю проще один выключатель, нет миграции, а точечный отказ
уже есть на уровне позиции (`holdings.auto_price`). Минус — согласие «на CoinGecko» не
равно согласию «на биржу»; режим тестовый, реальных пользователей нет, текст «ⓘ» обновляется.
Альтернатива — вопрос 1. Тумблер больше не зависит от ключа CoinGecko:
`auto_prices_available = true` (биржа без ключа), плюс `auto_sources: {coingecko: bool, moex: bool}`.
Выключатель на стороне сервера: `[vars] MOEX_PRICES = "on"` в `wrangler.toml` (иное значение →
провайдер `null`, ноль запросов к бирже) — для тестов и отката.

**3.8 Встраивание в `effectivePrice`.** Сигнатура расширяется политикой:
`effectivePrice(h, quote, today, nowIso, enabled, policy = CRYPTO_POLICY)`, где
`policy = {freshHours, maxAgeDays}`; `MOEX_POLICY = {96, 14}`. Жёсткая проверка
`kind !== 'crypto'` заменяется на `AUTO_KINDS = ['crypto','stock','bond']` (применимость
источника решает вызывающий по `priceRefFor`). Правила приоритета не меняются: свежая авто
бьёт ручную; старше — только если новее ручной; ручная никогда не перезаписывается.
Новая чистая функция `priceRefFor(kind, ticker) → {source:'coingecko'|'moex', id, market?} | null`
(`domain/prices-ref.ts` или в `domain/moex.ts`): crypto → `coinIdFor`; stock/bond → SECID,
если тикер проходит `MOEX_SECID_RE = /^[A-Z0-9-]{1,12}$/` (без точки).

**3.9 Шаг 0 — что сверить (executor, веб-доступ, до кода).** (a) единицы `LAST/MARKETPRICE`
облигаций (% номинала) и `ACCRUEDINT` (деньги, валюта) по `…/bonds/securities/columns.json`;
(b) работает ли `securities=A,B` на уровне рынка и есть ли `BOARDID`; лимит списка;
(c) поведение `SYSTIME` вне торгов; (d) параметры `/iss/securities.json` (`q`, `engine`,
`market`, `is_trading`, `limit`) и минимальная длина `q`; (e) состав бордов облигаций (TQOD/TQOY);
(f) доступность ISS с Cloudflare (запрос из `wrangler dev --remote` или стейджинга);
(g) «Порядок использования биржевой информации» (https://fs.moex.com/files/7064/46216): итог
вписать комментарием в `prices/moex.ts`. Ожидание: отложенные (15 мин) данные для личного
некоммерческого использования допустимы; **перед любым коммерческим использованием**
(платный тариф T7, реклама, публичное распространение котировок) — перечитать документ и,
вероятно, заключить договор с биржей. Атрибуция «Источник: Московская биржа (задержка 15 мин)»
показывается всегда.

**3.10 Сбои, паузы, fail-closed.** Таймаут 5 с (`AbortSignal.timeout`); паузы — общие из
`service.ts` (429 → 10 мин, 401/403 → 6 ч, 5xx/таймаут/кривой ответ → 2 мин), строка
`price_provider_state` с `source='moex'`. Кривой JSON (zod не прошёл) → `PriceUnavailable`.
GET портфеля **никогда** не отдаёт 5xx из-за цен: кэш ≤ 14 дн → ручная → «по цене покупки».
Поиск при сбое → 503 `provider_unavailable`; форма переключается на ручной ввод тикера.
Профиль выкл → ни поиска (409 `auto_disabled`), ни котировок, кэш не читается.

**3.11 Приватность.** Наружу (iss.moex.com) уходят только SECID пачкой и строка поиска,
которую пользователь сам ввёл; без имени, количеств, сумм, user_id; без cookies и
заголовков с данными проекта (обычный `accept: application/json`). Кэш без user_id.
Логи (правило 10): `price_fetch_failed source=moex status=… ids=N` и
`moex_search_failed status=…` — без тикеров и строк поиска. В текущем логе `service.ts`
добавить `source=`.

#### 4. Слои и файлы

| Слой | Файл | Что |
|---|---|---|
| Домен | `apps/api/src/domain/moex.ts` (новый) | `MOEX_BOARDS` (рынок → борды по приоритету), `MOEX_SECID_RE`, `moexCcy`, `mskToIso`, `pickMoexQuote(rows, kind)` (выбор борда и цены, 3.3), `bondUnitPrice(pct, face, aci)` |
| Домен | `apps/api/src/domain/decimal.ts` | `mulDec(a,b)`, `addDec(a,b)`, `divDecPow10(a, n)` — BigInt, half-up до 8 знаков, `null` при выходе за 12 цифр |
| Домен | `apps/api/src/domain/portfolio.ts` | `AUTO_KINDS`, `PricePolicy`, `CRYPTO_POLICY`, `MOEX_POLICY`; `effectivePrice(..., policy)`; `AutoQuote.vs?` |
| Домен | `apps/api/src/domain/coins.ts` или новый `domain/price-ref.ts` | `priceRefFor(kind, ticker)` |
| Данные | `apps/api/src/db/repo.ts` (`priceRepo`) | `getByIds(source, ids)` |
| Внешнее | `apps/api/src/prices/provider.ts` | `PriceProvider` += `quoteCurrency: 'requested'\|'native'`, `ttlMs?`, `fallbackMaxAgeDays?`; `ProviderQuote` без изменений (vs = родная валюта) |
| Внешнее | `apps/api/src/prices/moex.ts` (новый) | `createMoex(fetchImpl=fetch)`: `latest(ids)` — группировка по рынку (рынок передаётся в id как `shares:SBER`/`bonds:SU…` или отдельным аргументом — выбрать в шаге 1, ключ кэша — чистый SECID), пакеты по 10, zod `{securities:{columns,data}, marketdata:{columns,data}}`, `pickMoexQuote`; `search(q, market)` для эндпоинта; `MOEX_ATTRIBUTION = {text:'Источник: Московская биржа (задержка 15 мин)', url:'https://www.moex.com'}`; только Web API |
| Внешнее | `apps/api/src/prices/service.ts` | native-провайдеры (ключ по id, `getByIds`), TTL/запасной кэш из провайдера, `source=` в логе; `makePriceSources(db, {coingecko, moex}, now)` → `Record<source, PriceSource>` |
| Сервис | `apps/api/src/services/portfolio.ts` | `prices` → `Partial<Record<'coingecko'\|'moex', PriceSource>>`; refs через `priceRefFor`, по одному `get` на источник; `effectivePrice` с политикой источника; `auto_note` += `'ccy_mismatch' \| 'not_found'`; `auto_supported` — по `priceRefFor`; `auto` += `sources:{coingecko, moex}`, `attributions: [{text,url}]` (поле `attribution` убрать вместе с web в этой же задаче), `supported_tickers` — как было (крипта) |
| Wiring | `apps/api/src/env.ts`, `wrangler.toml` | `MOEX_PRICES?: string` в `[vars]` (`"on"`; в staging тоже) |
| Wiring | `apps/api/src/http/router.ts`, `services/access.ts` | `deps.moex?: PriceProvider \| null`; по умолчанию `env.MOEX_PRICES === 'on' ? createMoex() : null`; передать в holdings, profile, бот |
| TMA API | `apps/api/src/tma/holdings.ts` | `shapeError`: для stock/bond цена не обязательна, если есть тикер, проходящий `MOEX_SECID_RE`; новый маршрут поиска (§5) |
| TMA API | `apps/api/src/tma/profile.ts` | `auto_prices_available: true`, `auto_sources` |
| Бот | `apps/api/src/bot/invest.ts` | пометки «биржа · время», «с НКД», строка источника MOEX; экраны не меняются → `docs/ux/navigation.md`/`screens.json` без правок (`nav.test.ts` зелёный) |
| Web | `apps/web/src/api.ts` | типы `auto.sources`, `attributions`, `auto_note`, метод `moexSearch(kind, q)` |
| Web | `apps/web/src/screens/invest-common.ts` | `needsPrice`: stock/bond с тикером → false; `formError` без цены для них |
| Web | `apps/web/src/screens/invest-form.tsx` | `TickerField` для stock/bond: поиск (debounce 400 мс, от 2 символов) + «Другое…»; выбор подставляет тикер, имя (если пусто), валюту, вид по `group`; подсказка «в штуках, не в лотах»; при `auto_disabled`/сбое — свободный ввод |
| Web | `apps/web/src/screens/invest.tsx` | бейдж «биржа · ЧЧ:ММ»/«биржа · пт 18:49», «с НКД», пометки `ccy_mismatch`/`not_found`, список атрибуций (токены палитры) |
| Web | `apps/web/src/screens/profile-toggles.tsx` | «Автоцены», новый текст «ⓘ», не блокируется отсутствием ключа CoinGecko |
| Web | `apps/web/src/demo/mock.ts`, `demo/tw.tsx` | моки с акцией и облигацией |

Household (правило 20): `householdSummary` не меняется; партнёру — ни позиций, ни котировок.

#### 5. API (`/api/tma/*`, Bearer JWT, scoped(user.id), `user_id` не принимается)

| Метод | Путь | Изменение | Ошибки |
|---|---|---|---|
| GET | `/api/tma/holdings` | items: `price_source` (`'auto'` для биржи тоже) + новое `price_provider: 'coingecko'\|'moex'\|null`, `price_note: 'with_aci'\|null`, `auto_note` += `ccy_mismatch`, `not_found`; корень `auto` += `sources`, `attributions` | 401, 403; сбой цен → **200** |
| GET | `/api/tma/holdings/lookup?kind=stock\|bond&q=…` (новый) | zod: `kind` enum, `q` trim 2..32, `/^[\p{L}0-9 .-]+$/u` → `{items:[{secid, isin, name, kind, currency, board}]}` (≤ 10) | 400 `validation`, 409 `auto_disabled` (тумблер выкл), 503 `provider_unavailable` (ISS не ответил/пауза/выключен `MOEX_PRICES`) |
| POST / PATCH | `/api/tma/holdings[/:id]` | схема та же; `shapeError` смягчён для stock/bond с тикером; `client_id` — как в T3a (идемпотентность без изменений) | 400, 404 (чужой id), 409 `limit` |
| GET | `/api/tma/profile` | `auto_prices_available: true`, `+ auto_sources:{coingecko, moex}` | — |

Поиск не пишет в БД и не кэшируется в D1 (строки поиска — не храним). Лимит частоты —
debounce на клиенте; серверный лимит не вводим (риски).

#### 6. Шаги реализации (после каждого — `npm run check`)

0. Сверка (3.9) без кода; итог — комментарием в будущий `prices/moex.ts`; расхождение → `[DESIGN]`.
1. `decimal.ts` (`mulDec/addDec/divDecPow10`) + `domain/moex.ts` (`moexCcy`, `mskToIso`,
   `bondUnitPrice`, `pickMoexQuote`, `MOEX_BOARDS`) + тесты на фикстурах ISS (JSON-файлы в
   `apps/api/test/fixtures/moex/`: акция SBER, облигация ОФЗ RUB, юаневая CNY, null-цены, выходные).
2. `portfolio.ts`: `AUTO_KINDS`, политики, `effectivePrice(..., policy)`; `priceRefFor`. Тесты
   (старые тесты крипты зелёные без правок — политика по умолчанию = прежняя).
3. `provider.ts` (`quoteCurrency`, TTL), `priceRepo.getByIds`, `service.ts` (native-ключи,
   TTL/запасной кэш от провайдера, `source=` в логе, `makePriceSources`). Тесты сервиса.
4. `prices/moex.ts` (`latest`, `search`) на фейковом fetch + тесты.
5. `services/portfolio.ts` (несколько источников, `ccy_mismatch`/`not_found`, атрибуции);
   `env.ts`, `wrangler.toml [vars] MOEX_PRICES="on"`, `router.ts`, `access.ts`. Тесты сервиса.
6. `tma/holdings.ts` (`shapeError`, `lookup`), `tma/profile.ts`. Тесты API.
7. `bot/invest.ts` — пометки и источник; `nav.test.ts` без правок реестра.
8. Web: `api.ts`, `invest-common.ts`, `invest-form.tsx`, `invest.tsx`, `profile-toggles.tsx`, моки; тесты web.
9. Финал: `npm run check`; T3c → `[DOCS]`. Секретов нет — выкладка без действий владельца.

#### 7. Тесты

- **Домен:** `bondUnitPrice('96.1','1000','12.34') = '973.34'`; номинал 10000 и амортизированный
  (FACEVALUE 600); юаневая (`FACEUNIT 'CNY'`) → vs `CNY`; `ACCRUEDINT` null → 0; `FACEVALUE`
  null → нет котировки; 8-й знак half-up; переполнение → null. `pickMoexQuote`: LAST есть → LAST
  + SYSTIME; LAST null → LCURRENTPRICE → MARKETPRICE → PREVPRICE+PREVDATE; всё null → null; бумага
  только на SPEQ → null; TQBR приоритетнее TQTF. `mskToIso('2026-11-13 18:49:59') =
  '2026-11-13T15:49:59.000Z'`; кривая строка → null. `moexCcy('SUR')='RUB'`. `effectivePrice` с
  `MOEX_POLICY`: котировка пятницы в воскресенье (≈ 2 дня) — свежая, бьёт ручную; 15 дней →
  ручная; `CRYPTO_POLICY` — прежние кейсы без изменений. `priceRefFor('stock','SBER')` → moex;
  `('crypto','SBER')` → null; `('bond','RU.X')` → null.
- **Провайдер (фейковый fetch):** один запрос на рынок, пакеты по 10; в URL только SECID и
  служебные параметры; `iss.meta=off`, урезанные `columns`; таймаут/500/429 → `PriceUnavailable`;
  кривой JSON → то же; null-цены → бумага просто без котировки, остальные пришли.
- **Сервис цен:** native-ключи — позиция SBER в USD не вызывает повторный fetch при свежем кэше
  (0 вызовов); сбой → кэш до 14 дней (`stale:true`), 15 дней → нет; пауза `source='moex'` не
  блокирует CoinGecko и наоборот.
- **Портфель:** облигация CNY в портфеле с бюджетом в USD → итог через FX; нет курса CNY →
  `missing_rates:['CNY']`, позиция видна; позиция SBER в USD → `ccy_mismatch`, оценка по ручной/
  «по цене покупки»; нет торгов (котировка 20 дней в кэше) → ручная или `valued_at_cost`.
- **«A не видит B»:** A (SBER), B (облигация), оба вкл.: GET A — без позиций/цен B; запрос к ISS
  от A содержит только `SBER`; PATCH/DELETE по id позиции B от A → 404; `lookup` не возвращает и
  не пишет ничего пользовательского (сырая проверка: в `price_quotes` нет `user_id`, число строк
  holdings B не изменилось). A выкл, B вкл → GET A: 0 вызовов ISS; `lookup` от A → 409.
- **Fail-closed:** `MOEX_PRICES` не `"on"` → 0 запросов к ISS, `auto.sources.moex=false`, 200;
  ISS падает → 200, ни одного 5xx на GET; `lookup` при сбое → 503; без JWT → 401;
  `q` из 1 символа/с `<script>` → 400.
- **Идемпотентность:** POST акции без цены с тикером и `client_id` дважды → одна строка.
  `shapeError`: акция без тикера и без цены → 400; облигация с тикером без цены → 201.
- **Логи:** перехват `console.*` при сбое ISS и поиска — нет SECID, строк поиска, тел ответов.
- **Ручная цена не теряется:** после GET с биржевой ценой сырой `SELECT price` — прежний `enc1:`.
- **Household:** `householdSummary` без котировок.
- **Web:** `needsPrice` для stock/bond с тикером = false; выбор из поиска ставит тикер, валюту,
  вид; при 409/503 — свободный ввод; бейдж «биржа», «с НКД», атрибуция MOEX видна только при
  наличии биржевых позиций.

#### 8. Риски и откат

| Риск | Мера |
|---|---|
| Единицы цены облигации поняты неверно (не %) | шаг 0 по описанию столбцов; golden-фикстура из живого ответа; тест 96.1% × 1000 |
| ISS недоступен с IP Cloudflare / блокировки | шаг 0 (f); fail-closed — ручная/«по цене покупки»; выключатель `MOEX_PRICES` |
| Условия биржи запрещают распространение в многопользовательском боте | личное/тестовое использование; шаг 0 (g); перед коммерцией — перечитать и договор; атрибуция всегда |
| Неверный борд (бумага торгуется на нескольких) | белый список + приоритет; вне списка — нет автоцены |
| Неликвидная облигация: цена месячной давности | время котировки показывается; `maxAgeDays=14`, дальше — ручная/по цене покупки |
| Валюта позиции ≠ валюте бумаги | без конвертации цены, `ccy_mismatch` с подсказкой; форма ставит валюту сама |
| Поиск дёргается на каждый символ | debounce 400 мс, от 2 символов, только при включённом тумблере; при злоупотреблении — серверный лимит отдельной задачей |
| Перерасход подзапросов Workers Free | ≤ ~15 на GET (расчёт 3.6), без cron |
| НКД путает пользователя (стоимость падает после купона) | подпись «с НКД» и пояснение в «ⓘ»; купоны — T3d |
| Ослабление «цена обязательна» для stock/bond | без котировки — «по цене покупки» (T10), позиция не обнуляется |

**Откат.** Миграции нет. Мгновенно: `MOEX_PRICES = "off"` в `wrangler.toml` + `npm run release`
— ноль запросов к бирже, всё на ручных ценах (без релиза — строка паузы в `price_provider_state`
для `source='moex'` с далёким `blocked_until`; это правка живой базы, в боевом режиме — по «Да»
владельца). Кодом — откат коммита; строки `price_quotes` с `source='moex'` — не данные
пользователей, могут остаться или быть удалены новой миграцией
`0026_drop_moex_quotes.sql` (`DELETE FROM price_quotes WHERE source='moex'; DELETE FROM price_provider_state WHERE source='moex';`).
Если был выбран отдельный тумблер — откат колонки новой миграцией `ALTER TABLE profiles DROP COLUMN moex_prices_enabled;`.

#### 9. Затронутая документация (для `documenter`)

- `AGENTS.md` правило 21 — «Облигации и акции (MOEX) — T3c» → описание: провайдер MOEX ISS без
  ключа, `source='moex'`, SECID в `ticker`, белый список бордов (`domain/moex.ts`), цена облигации
  `% × номинал / 100 + НКД` на BigInt, родная валюта котировки без конвертации, `MOEX_POLICY`
  (96 ч / 14 дн), общий тумблер `auto_prices_enabled`, выключатель `MOEX_PRICES`, атрибуция MOEX,
  оговорка о коммерческом использовании.
- `docs/ARCHITECTURE.md` — слой `prices/` (moex), эндпоинт `lookup`, `[vars] MOEX_PRICES`.
- `SECURITY.md` — «Коды бумаг и строки поиска → iss.moex.com (opt-in)».
- `README.md`, `CHANGELOG.md`, `docs/v2-development.md` (переменная `MOEX_PRICES`, staging).
- `docs/BACKLOG.md` P1-9, `TASKS.md` — T3c закрыта; впереди T3d.

#### 10. Вопросы владельцу (простым языком; в скобках — по умолчанию)

1. Один общий выключатель «Автоцены» для крипты и Мосбиржи? (По умолчанию — да, один; отдельный — потребует небольшого изменения базы.)
2. Стоимость облигации считать вместе с накопленным купонным доходом (НКД) — то есть сколько вы реально получили бы при продаже? (По умолчанию — да, с подписью «с НКД».)
3. Бумагу выбирать поиском по Мосбирже (название, тикер или ISIN) с возможностью ввести тикер вручную? (По умолчанию — да.)
4. Если у акции или облигации есть тикер, не требовать «цену сейчас» — её даст биржа, а без неё считать по цене покупки? (По умолчанию — да.)
5. Пользуемся биржевыми ценами только для личного учёта, а перед любой платной версией бота заново проверяем правила биржи? (По умолчанию — да.)

задачу можно переводить в `[READY]`
