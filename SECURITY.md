# 🔐 SECURITY.md — аудит безопасности и политика секретов

Аудит: 2026-10-28 · Код: `apps/api` + `apps/web` ·
Полный отчёт: [AUDIT_REPORT.md](AUDIT_REPORT.md) ·
Карта системы: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

> Legacy-стек (Apps Script + Google Sheets) удалён на шаге 9 миграции —
> его аудит остался в истории git.

## Модель угроз

| Актив | Угроза | Контроль |
|-------|--------|----------|
| Данные пользователей в D1 | чтение/запись чужих данных (IDOR) | Изоляция на уровне кода: доступ только через `scoped(db, userId)` в `src/db/repo.ts` — каждый запрос содержит `WHERE user_id = ?`; мутации по id — `WHERE id=? AND user_id=?` (чужой id → 404 в REST / молча в боте); сырые `db.prepare` вне repo.ts запрещены; обязательные тесты «A не видит B» |
| Секреты (токен бота, JWT, webhook) | утечка в git/код/логи | Только `wrangler secret put`; локально `.dev.vars` (в `.gitignore`, шаблон `.dev.vars.example`); токен бота существует только на сервере, во фронте нет `VITE_*`-секретов |
| Webhook `POST /telegram/webhook` | поддельные апдейты | Заголовок `X-Telegram-Bot-Api-Secret-Token`; fail-closed (нет секрета → 503); сравнение constant-time — дайджесты SHA-256 без раннего выхода (`src/http/security.ts`) |
| Повторная доставка webhook / ретрай Mini App | дубли записей | `processed_updates` (PK `update_id`); денежные журналы и справочники — `UNIQUE(user_id, source_key)` с ключами `tg:<update_id>`, `tma:<client_id>`, `auto:<объект>:<период>` |
| Сессия Mini App | подделка initData, кража токена | `POST /api/tma/auth`: HMAC-SHA256 «WebAppData» от токена бота (Web Crypto), `auth_date` ≤ 24ч и не из будущего >5 мин, обязательный `user.id`; дальше JWT HS256 `{tg_id}` на 12ч и только `Authorization: Bearer` — токенов в URL нет; JWT живёт в памяти SPA (не в localStorage) |
| Брутфорс `/api/tma/auth` | подбор initData | Rate-limit 20 попыток / 10 мин по SHA-256 от `CF-Connecting-IP` (таблица `rate_limit`, сам IP не храним); одинаковый 403 для «нет пользователя» и «не онбоарден» — факт существования аккаунта не раскрывается |
| Доступ к боту | посторонние пользователи | Владелец бутстрапится по `OWNER_TELEGRAM_ID`; участники — одноразовые инвайты: код 128 бит, в БД только SHA-256 хэш, TTL 48ч, лимит 10 активных, в audit_log — `expires_at`, не код; незнакомцам — тишина и ноль записей в БД |
| Удалённый пользователь | живой JWT после `/delete_me` | `deleted_at` в `users`: `findUserByTelegramId` удалённых не возвращает → 403 на всех `/api/tma/*` и молчание в боте |
| Скриншоты → внешний AI | данные видит сторонний провайдер | Opt-in: `profiles.vision_enabled` DEFAULT 0 — без согласия фото наружу не уходит; провайдеры Gemini (основной) и Groq (резерв) — ключи только в секретах воркера; лимит 20 скринов/день и 10 МБ; байты и ответы провайдеров не логируются |
| Логи | утечка PII/секретов | Запрещено логировать текст сообщений, токены, коды инвайтов и их хэши, байты изображений, тела ответов провайдеров; в логах — `update_id`, счётчики и коды ошибок (`sanitizeTelegramError` → error_code) |
| Внешние вызовы | данные третьим сторонам | Только `api.telegram.org`, `api.frankfurter.dev` (курсы, без ключа), `generativelanguage.googleapis.com`, `api.groq.com` (vision, по согласию); таймаут `AbortSignal.timeout(8s)` (vision — 20s); `api.coingecko.com` (автоцены крипты, opt-in `profiles.auto_prices_enabled`: id монет → CoinGecko, наружу — только id монет и валюта котировки, ключ `COINGECKO_API_KEY` — заголовком; таймаут 5s); `iss.moex.com` (автоцены акций и облигаций Мосбиржи, opt-in `profiles.auto_prices_enabled` и `[vars] MOEX_PRICES="on"`; ключа нет; наружу — только SECID бумаг и строка поиска; таймаут 5s) |
| Mini App (XSS/кликджекинг) | внедрение скриптов, фрейминг | CSP: `default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; frame-ancestors` — только `*.telegram.org`; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` на `/api/*` и `/telegram/*` |

## Шифрование данных at rest (вариант A)

Чувствительные поля в D1 (суммы, названия платежей/долгов, контрагенты, заметки,
JSON состояния диалога) хранятся шифртекстом `enc1:…`: AES-GCM-256, per-user ключ —
HKDF-SHA256 от секрета `DATA_KEY` (salt 'budget-companion/data/v1', info 'user:<id>'),
AAD '<table>.<col>:<userId>' (src/db/crypto.ts). Шифрование/дешифровка — только в
`repo.ts`; сырой D1-дамп/консоль/бэкап/Time Travel-экспорт без `DATA_KEY` бесполезен.

**Не защищает** от владельца секрета (Cloudflare-доступ = DATA_KEY), скомпрометированного
кода воркера и самого Telegram. Метаданные остаются plaintext: даты, валюты, id,
флаги, виды событий, счётчики — по ним видна активность, но не суммы/имена.
D1 Time Travel хранит до-бэкфилл plaintext до 30 дней. Потеря `DATA_KEY` =
необратимая потеря данных; ротация не реализована (префикс `enc1:` резервирует версию).

## Секреты и git

- Прод — только `wrangler secret put`: `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET`, `OWNER_TELEGRAM_ID`,
  опционально `GEMINI_API_KEY`/`GEMINI_MODEL`, `GROQ_API_KEY`/`GROQ_MODEL`,
  `COINGECKO_API_KEY` (автоцены крипты; без него цены остаются ручными).
  Несекретные `[vars]` в `wrangler.toml`: `TELEGRAM_BOT_USERNAME`,
  `MINI_APP_URL`, `MOEX_PRICES` (аварийный выключатель автоцен Мосбиржи; не секрет).
- Локально — `apps/api/.dev.vars` (в `.gitignore`); шаблон
  `apps/api/.dev.vars.example`. `TELEGRAM_WEBHOOK_SECRET` и `JWT_SECRET`
  генерируются случайно (`openssl rand -hex 32`).
- Мастер `npm run setup` кладёт секреты через `wrangler secret put` (значения
  не печатаются и не сохраняются); повторный запуск безопасен, при этом
  `TELEGRAM_WEBHOOK_SECRET` генерируется заново — прочитать его обратно нельзя.
- В репозитории — только плейсхолдеры (`123456789:AAxxx…`); контроль —
  pre-commit хук (`scripts/hooks/pre-commit`, ставится при `npm install`)
  и `gitleaks` в CI (правила `.gitleaks.toml`: токен Telegram
  `\d{8,10}:[A-Za-z0-9_-]{35}`, ключ Google `AIza…`, явные присваивания
  `*_SECRET=...`).

```bash
gitleaks detect -c .gitleaks.toml --redact                # по всем коммитам
gitleaks protect --staged --redact -c .gitleaks.toml      # по индексу
```

## Что делать при утечке

| Утечка | Действие |
|--------|----------|
| Токен бота | @BotFather → `/mybots` → API Token → **Revoke** → `npm run wrangler -- secret put TELEGRAM_BOT_TOKEN` |
| `JWT_SECRET` | `npm run setup -- --rotate` (или `wrangler secret put JWT_SECRET` новым `openssl rand -hex 32`) — все сессии Mini App обнулятся, пользователи войдут заново |
| `TELEGRAM_WEBHOOK_SECRET` | `npm run setup` перегенерирует и загрузит сам; вручную — новый `openssl rand -hex 32` → `wrangler secret put` → `npm run webhook:set -- <url>` |
| `GEMINI_API_KEY`/`GROQ_API_KEY` | Перевыпустить у провайдера → `wrangler secret put` новым значением |
| `COINGECKO_API_KEY` | Перевыпустить Demo-ключ в личном кабинете CoinGecko → `wrangler secret put COINGECKO_API_KEY` новым значением |
| `OWNER_TELEGRAM_ID` задан неверно | `wrangler secret put OWNER_TELEGRAM_ID` верным значением; проверить созданных пользователей в D1 |
| API-токен Cloudflare (CI) | dash.cloudflare.com → API Tokens → Roll/Delete → обновить `CLOUDFLARE_API_TOKEN` в GitHub Secrets |
| Данные пользователя | По запросу — `/delete_me` у пользователя; админ-удаление — `wrangler d1 execute` по `user_id` (см. список таблиц в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) |

После любой ротации — прогнать `npm run check` локально и `wrangler tail` на
живом воркере.
