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
