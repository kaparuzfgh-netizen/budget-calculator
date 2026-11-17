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
