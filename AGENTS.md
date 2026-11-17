# AGENTS.md — заметки для ИИ-агентов и автоматизации

## Проект

Мультипользовательский Telegram-бот + Mini App личных финансов на
Cloudflare (миграция v1→v2 завершена шагом 9 — legacy-стек удалён,
см. [ADR-0001](docs/adr/0001-platform-and-architecture.md)):

- **`apps/api`** — Cloudflare Worker: TypeScript strict, Hono, D1
  (`wrangler d1 migrations`), cron (напоминания, автопроводки, FX-алерты),
  vision-провайдеры (Gemini → Groq), FX-аналитика (Frankfurter).
- **`apps/web`** — Mini App на Vite + Preact; раздаётся тем же воркером
  через Workers Static Assets.
- Разработка — `docs/v2-development.md`.

## Команды

- `npm ci` — все зависимости (workspaces: apps/*).
- `npm run check` — lint + typecheck + тесты API и web + сборка web.
  **Обязательно перед коммитом.**
- `npm test` — тесты API (vitest в workerd с локальной D1) + тесты web
  (`npm run test:api` / `npm run test:web` по отдельности).
- `npm run typecheck` — `tsc --noEmit` по `apps/*`.
- `npm run build:web` — сборка `apps/web` → `dist`.
- `npm run release` — релиз: check → web → миграции D1 → deploy → /health.
- `npm run setup` — мастер подключения бота (токен BotFather один раз,
  дальше всё само; `--dry-run` печатает план). Суффикс `:staging` —
  то же для стейджинг-окружения (`--env staging`, свой воркер/D1/бот;
  docs/v2-development.md «Стейджинг-окружение`).
- `npm run dev -w apps/api` — wrangler dev (локальный воркер + D1).
- `npm run wrangler -- <команда>` — wrangler workspace apps/api.
- `npm run wrangler -- login` — только пользователь (браузер).

## Жёсткие правила

1. **Никогда не коммитить секреты**: `secrets.json`, `.env`, `.dev.vars`,
   `.clasp.json`, `.deploy.json` — всё в `.gitignore`. Секреты воркера —
   `wrangler secret put`, локально — `.dev.vars` (в .gitignore).
2. **Workers ≠ Node**: в коде `apps/api` — только Web API (fetch, Web Crypto,
   `crypto`, `URL`, `URLSearchParams` здесь ЕСТЬ), никаких `process`, `fs`,
   `Buffer`, `node:*`. Тесты идут в workerd — но статически такие ошибки линтер
   не ловит, будь внимателен.
3. **Изоляция tenant (S5):** доступ к БД — только через `scoped(env.DB, userId)`
   (`apps/api/src/db/repo.ts` — фасад; части по доменам — `db/scoped/*.ts`,
   `this` между частями не использовать); каждый запрос обязан содержать
   `WHERE user_id = ?` (или join через таблицу с user_id). Сырые
   `db.prepare(...)` вне `db/repo.ts` и `db/scoped/*` запрещены; тест «A не видит B» обязателен.
   `user.id` — последовательный и НЕ должен быть клиентским входом:
   эндпоинт, принимающий user_id параметром, = тривиальный IDOR
   (обязателен предикат + тест, либо UUID-ссылки).
4. **Никаких токенов в URL** — только `Authorization: Bearer <JWT>` после
   проверки `initData`. Секреты — `wrangler secret put`, локально — `.dev.vars`.
5. Миграции — только новые файлы `migrations/NNNN_name.sql` (иммутабельны);
   применение — `wrangler d1 migrations apply DB [--local|--remote]`.
6. Zod-схемы на каждом входе; домен в `src/domain/` — чистые функции без I/O
   («сегодня» — параметром; числа-эталоны — `test/domain/golden.legacy.json`,
   фикстура заморожена, генератор удалён вместе с v1).
7. Деплой выполняет агент сам: `npm run release` (check → web → миграции
   D1 → deploy → /health) при зелёном `npm run check`, если нет отдельного
   уточнения пользователя. Интерактивные `wrangler login`/`logout` и
   `wrangler secret put` — только владелец (браузерная авторизация и
   прод-секреты). Секреты CI (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
   настраивает владелец — docs/v2-development.md.
8. `node_modules/`, `dist/`, `.wrangler/`, `dist-check/` — не трекаются.
9. **Mini App API:** `/api/tma/*` — Bearer-JWT, только scoped(user.id), суммы
   minor units, идемпотентность `client_id`; правила — как у бота
   (та же валидация).
10. **Вебхук:** никогда не логировать текст сообщений, токены, коды инвайтов
    и их хэши, байты изображений и тела ответов провайдеров (в логах — только
    `update_id` и код ошибки). Незнакомым отправителям — тишина и ноль записей
    в БД. Код приглашения хранится только как SHA-256 hex; в audit_log —
    `expires_at`, не код.
11. **Деньги:** в D1 — INTEGER minor units (копейки); домен — float,
    конвертация `toMinor/fromMinor` на границе repo. Курсы — только через
    `getFxRates` (D1-кэш 6ч + provider). Онбординг — чистый редьюсер
    `bot/onboarding.ts` (эффекты исполняет services/access.ts). Мастера бота
    (pf/debt/loan/fx) — реестр `services/flows.ts` (`Flow`: шаги, текстовые
    шаги, редьюсер, рендер, эффекты); новый мастер — новая запись реестра,
    маршрутизация в access.ts не дублируется.
12. **Навигация бота:** источник истины — `docs/ux/navigation.md` +
    `src/bot/nav/screens.json` (zod-реестр). Любое изменение экранов
    сначала вносится в оба; нав-ряды только через `navRow()` (R1–R4),
    колбэки `nv:home`/`nv:back:<id>`/`nv:go:<id>` whitelist-ятся реестром.
    Тест `nav.test.ts` сверяет реестр, mermaid-схему и ряды.
13. **Профиль:** `income_minor` — «базовый доход»: >0 — явный, 0 — база
    вычисляется из обязательств (активные платежи + бюджет + месячные
    платежи кредитов; `services/baseline.ts` → `computedBaselineUsd`,
    личные займы не входят); факт — `income_entries` по месяцам (`/income`).
    Источник дохода — `resolveIncome` в `bot/features.ts` (аргумент →
    факт → explicit → computed → none). Правки профиля — редьюсер
    `bot/profile.ts` (`advancePf`); колбэки `pf:*`/`in:*` step-aware
    (`PF_STEPS`), CAS-запись состояния; ВСЕ мутации по id —
    `WHERE id=? AND user_id=?` (чужие id молча игнорируются).
14. Проверка `X-Telegram-Bot-Api-Secret-Token` — fail-closed (нет секрета в
    env → 503) и константная по времени (`src/http/security.ts`).
15. **Mini App:** SPA — Workers Static Assets в том же воркере
    (`wrangler.toml [assets]` → `../web/dist`, SPA-fallback;
    `run_worker_first = ["/api/*", "/telegram/*", "/health"]`, иначе
    SPA перехватит эти пути). Перед `wrangler deploy` — сборка `apps/web`
    (в `scripts/release.mjs` и CI уже есть). Auth: `POST /api/tma/auth
    {initData}` — HMAC «WebAppData» по токену бота (Web Crypto),
    `auth_date` ≤ 24ч, юзер onboarded → JWT HS256 `{tg_id}` на 12ч
    (`src/tma/auth.ts`); дальше `Authorization: Bearer` на `/api/tma/*`
    (любой не-валидный → 401). Запуск Mini App — menu-button у поля ввода
    (`setChatMenuButton`, `web_app` → `MINI_APP_URL` из `[vars]`): ставится
    в `npm run setup` или `node scripts/telegram-webhook.mjs menu <url>`.
    Inline-кнопки «📱 Приложение» в экранах бота нет.
    Темы dark/light — CSS-переменные палитры (`html.light` в index.css):
    полупрозрачные оверлеи — только через токены line/fill/scrim/shade
    (@theme), literal `white|black/<alpha>` в классах запрещён
    (`text-white` на акцентных кнопках — исключение).
16. **Vision (шаг 7):** `profiles.vision_enabled` — opt-in (DEFAULT 0);
    без флага фото провайдеру не уходит. Провайдеры: Gemini (`GEMINI_API_KEY`,
    модель `GEMINI_MODEL`, дефолт `gemini-3.5-flash-lite`) → резерв Groq
    (`GROQ_API_KEY`, `GROQ_MODEL`). Лимит 20 скринов/день, фото ≤10 МБ.
17. **FX (шаг 8):** алерты по перцентилю (≥85 hi / ≤15 lo, кулдаун —
    ISO-неделя через `claimReminder('fx', …)`); флаг
    `profiles.fx_alerts_enabled` (DEFAULT 1). Журнал обменов — `exchanges`,
    rate/market_rate в единицах to за 1 from.

19. **Шифрование at rest:** чувствительные текстовые/денежные колонки
    пользовательских таблиц — шифртекст `enc1:` (per-user AES-GCM, src/db/crypto.ts,
    спек `FIELDS`). Работа с ними — только через хелперы crypto.ts внутри repo.ts;
    сырые запросы по ним не писать и в WHERE не использовать. Новая пользовательская
    текстовая/amount-колонка ОБЯЗАТЕЛЬНО добавляется в `FIELDS`.
    `users.display_name` — тоже `enc1:`, но uid там = `users.id`
    (колонки `user_id` нет); имя обновляется refresh-on-change на вебхуке
    и в `/api/tma/auth` (`accessRepo.refreshDisplayName`). `households`
    — тоже self-keyed (ключ от `households.id`): insert двухшаговый,
    как у users.
20. **Общий бюджет пары:** `households` + `household_members` (≤2 члена,
    юзер — максимум в одном). Членство проверяется на КАЖДЫЙ запрос
    (`householdFor(user.id)`), наружу — только агрегаты по людям
    (`householdSummary`): строки трат и категории партнёра не отдаются.
    Приглашение — `invites.kind='household'` + `household_id`, код
    `hh_<hex>` (хэш хранится от полного кода с префиксом). Выход члена
    удаляет только ЕГО опустевший household (+ зануляет
    `invites.household_id` — FK), чужие пустые не трогает.
21. **Инвестиции (T3a — ручной портфель, T3b — автоцены крипты):** таблица `holdings` (миграция 0023; `auto_price` — миграция 0024),
    колонка `profiles.invest_targets`. Количество и цены — канонические десятичные
    строки (`domain/decimal.ts`: до 12 цифр до точки и до 8 после, больше нуля);
    арифметика — на BigInt (`mulToMinor`, округление half-up до minor units).
    Их НЕЛЬЗЯ переводить через `toMinor` или float: это теряет 8-й знак количества
    и обнуляет цены мелких токенов. Суммы вкладов и «другого» — `amount_minor`
    (minor units валюты позиции). Все текстовые, денежные и процентные поля позиции
    и `invest_targets` — в `FIELDS` (`db/crypto.ts`): `name`, `ticker`, `quantity`,
    `avg_price`, `price`, `amount_minor`, `rate`, `note`, `invest_targets`. По ним не
    пишем сырые WHERE и SQL-агрегаты: суммы и доли считаются в JS после дешифровки
    (`listHoldings`). `currency`, `price_on`, даты — plaintext. Партнёру по household
    позиции и цели не отдаются (`householdSummary` их не содержит). Ручная цена вводится
    с датой `price_on`; старше 30 дней — «цена устарела».
    **Автоцены крипты (T3b):** только для `kind='crypto'` с тикером из белого списка
    `domain/coins.ts` (тикер → id монеты CoinGecko; символы на CoinGecko не уникальны,
    поэтому вне списка — только ручная цена). Провайдер — CoinGecko Demo (`prices/coingecko.ts`,
    секрет `COINGECKO_API_KEY`, ключ только заголовком `x-cg-demo-api-key`; без ключа — ноль
    внешних запросов). Включается opt-in-флагом профиля `profiles.auto_prices_enabled`
    (DEFAULT 0) и флагом позиции `holdings.auto_price` (DEFAULT 1; 0 — всегда ручная).
    Наружу уходят только id монет и валюта котировки — без имён, сумм и количеств.
    Общий кэш `price_quotes` (PK `source, asset_id, vs_currency`, миграция 0024) — без
    `user_id`, как `fx_rates`; доступ — `priceRepo` в `db/repo.ts`; TTL 15 мин; один пакетный
    запрос по ненайденным монетам. Пауза провайдера — `price_provider_state` (429 → 10 мин,
    401/403 → 6 ч, 5xx/таймаут/кривой ответ → 2 мин); при сбое — запасной кэш не старше 7 дней.
    Приоритет (`domain/portfolio.ts`, `effectivePrice`): свежая автоцена (≤24 ч) бьёт ручную;
    автоцена 1–7 дней — только если новее ручной; **ручная цена никогда не перезаписывается**
    (автоцена не пишется в `holdings`, а вычисляется при чтении). Атрибуция «Data provided by
    CoinGecko» со ссылкой https://www.coingecko.com/en/api обязательна в Mini App и в боте.
    Облигации и акции (MOEX) — T3c, журнал сделок — T3d.
    Итог считает `services/portfolio.ts`: курс запрашивается по каждой валюте толерантно;
    валюта без курса — позиция видна, в итог не входит, код в `missing_rates`.
    Тест «A не видит B» для `holdings` обязателен.
