# 🔐 SECURITY.md — аудит безопасности и политика секретов

> До шага 9 миграции в репозитории два стека — документ в двух разделах:
> **v2** (Cloudflare Workers + D1, прод) ниже и **v1** (Apps Script +
> Google Sheets, legacy) — «Раздел v1» далее.

## Раздел v2 (Cloudflare Workers)

Аудит: 2026-10-28 · Код: `apps/api` + `apps/web` ·
Полный отчёт: [AUDIT_REPORT.md](AUDIT_REPORT.md) ·
Карта системы: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

### Модель угроз v2

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
| Логи | утечка PII/секретов | Запрещено логировать текст сообщений, токены, коды инвайтов и их хэши; в логах — `update_id`, счётчики и коды ошибок (`sanitizeTelegramError` → error_code) |
| Внешние вызовы | данные третьим сторонам | Только `api.telegram.org` и `api.frankfurter.dev` (курсы ЦБ, без ключа); таймаут `AbortSignal.timeout(8s)` |
| Mini App (XSS/кликджекинг) | внедрение скриптов, фрейминг | CSP: `default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; frame-ancestors` — только `*.telegram.org`; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` на `/api/*` и `/telegram/*` |

### Секреты и git (v2)

- Прод — только `wrangler secret put`: `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET`, `OWNER_TELEGRAM_ID`.
  Несекретные `[vars]` в `wrangler.toml`: `TELEGRAM_BOT_USERNAME`, `MINI_APP_URL`.
- Локально — `apps/api/.dev.vars` (в `.gitignore`); шаблон
  `apps/api/.dev.vars.example`. `TELEGRAM_WEBHOOK_SECRET` и `JWT_SECRET`
  генерируются случайно (`openssl rand -hex 32`).
- Мастер `npm run setup` кладёт секреты через `wrangler secret put` (значения
  не печатаются и не сохраняются); повторный запуск безопасен, при этом
  `TELEGRAM_WEBHOOK_SECRET` генерируется заново — прочитать его обратно нельзя.
- В репозитории — только плейсхолдеры (`123456789:AAxxx…`); контроль — те же
  pre-commit хук и `gitleaks`, что у v1 (см. раздел v1, §4).

### Что делать при утечке (v2)

| Утечка | Действие |
|--------|----------|
| Токен бота | @BotFather → `/mybots` → API Token → **Revoke** → `wrangler secret put TELEGRAM_BOT_TOKEN` (через `npm run wrangler -- secret put …`) |
| `JWT_SECRET` | `npm run setup -- --rotate` (или `wrangler secret put JWT_SECRET` новым `openssl rand -hex 32`) — все сессии Mini App обнулятся, пользователи войдут заново |
| `TELEGRAM_WEBHOOK_SECRET` | `npm run setup` перегенерирует и загрузит сам; вручную — новый `openssl rand -hex 32` → `wrangler secret put` → `npm run webhook:set -- <url>` |
| `OWNER_TELEGRAM_ID` задан неверно | `wrangler secret put OWNER_TELEGRAM_ID` верным значением; проверить созданных пользователей в D1 |
| API-токен Cloudflare (CI) | dash.cloudflare.com → API Tokens → Roll/Delete → обновить `CLOUDFLARE_API_TOKEN` в GitHub Secrets |
| Данные пользователя | По запросу — `/delete_me` у пользователя; админ-удаление — `wrangler d1 execute` по `user_id` (см. список таблиц в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) |

После любой ротации — прогнать `npm run check` локально и `wrangler tail` на
живом воркере.

---

## Раздел v1 (Google Apps Script + Google Sheets)

Дата аудита: 2026-10-24 · Код: `apps-script/` + `mini-app/index.html`

### 1. Модель угроз

| Актив | Угроза | Контроль |
|-------|--------|----------|
| Финансовые данные в таблице | чтение посторонним по ссылке Web App | `TMA_READ_TOKEN` / подпись initData (см. §3, F2) |
| Секреты (токены, ключи) | утечка в git/код | Script Properties + `.gitignore` + pre-commit хук (§4) |
| Webhook | поддельные апдейты от имени Telegram | `WEBHOOK_SECRET` в URL webhook + `secret_token` (F4) |
| Бот | команды от чужих чатов | whitelist `TELEGRAM_CHAT_ID` (F5) |
| Mini App записи (ЧДП) | подделка запросов | HMAC-SHA256 проверка `initData` + свежесть 24 ч (F6) |
| Таблица | formula-injection через текст заметок | санитайзер `safeCellText_` (F1) |
| Квоты Gemini/UrlFetch | сжигание гигантскими файлами | лимит изображения 8 МБ (F3) |
| Скриншоты → внешний AI | данные видит сторонний провайдер | Gemini (Google AI Studio) — основной; **Groq — резерв** (P1, только при недоступности Gemini). Оба — крупные провайдеры, ключи только в Script Properties; скриншоты содержат суммы, но не реквизиты карт/CVV (рекомендация: не присылать экраны с полными реквизитами) |

### 2. Отчёт аудита (что проверено и исправлено)

| # | Находка | Severity | Статус |
|---|---------|----------|--------|
| F1 | **Formula-injection**: заметки пользователя (`/spent ... =cmd()`) попадали в ячейки и могли исполниться как формулы Sheets | High | ✅ Исправлено: `safeCellText_()` экранирует текст, начинающийся с `= + - @` |
| F2 | **Публичное чтение**: `doGet?action=overview` отдавал Net Worth/долги/портфель любому, знающему URL развёртывания | High | ✅ Исправлено: `TMA_READ_TOKEN` — **генерируется автоматически** при `setup()`; чтение требует токен или подпись initData (открытый демо-режим — только если удалить токен вручную) |
| F3 | Отсутствие лимита на размер файла → расход квоты Gemini и трафика | Medium | ✅ Исправлено: проверка `file_size` + фактического размера, лимит 8 МБ |
| F4 | Подделка webhook | High | ✅ Контроль: случайный `WEBHOOK_SECRET` в query URL + `secret_token` при `setWebhook`. Остаточный риск: GAS не отдаёт заголовки запроса в `doPost`, поэтому проверяется query-параметр; URL с секретом не публикуется (в `debugWebhook` маскируется) |
| F5 | Чужие чаты | Medium | ✅ Whitelist `TELEGRAM_CHAT_ID`; до его настройки бот лишь отвечает просившему его chat_id, данные не отдаёт |
| F6 | Подделка записей Mini App | High | ✅ `validateInitData_()`: HMAC-SHA256 (`WebAppData` → bot token → check string), сравнение hex, отклонение старше 24 ч; записи без валидной подписи запрещены |
| F7 | Секреты в коде/git | High | ✅ Все секреты — только в Script Properties; в репозитории шаблон `secrets.example.json` без значений; `.gitignore`; хук; `securityAudit()` проверяет длину `WEBHOOK_SECRET` |
| F8 | Секрет в логах (`getWebhookInfo.url` содержит `?secret=...`) | Low | ✅ Маскируется в `debugWebhook()` |
| F9 | Утечка внутренностей в ошибках API | Low | ✅ Клиенту — только сообщение исключения (без стека и секретов); полный стек — в консоль владельцу |
| F10 | Гонки записи (webhook + триггеры) | Medium | ✅ `runWithLock_()` (LockService) на все мутации |
| F11 | XSS в Mini App | Medium | ✅ Vue экранирует интерполяцию, `v-html` не используется |
| F12 | SSRF через внешний URL | Low | ✅ Не применимо: все UrlFetch идут на фиксированные домены (`api.telegram.org`, `generativelanguage.googleapis.com`, `api.groq.com`) |
| F13 | Резервный провайдер Groq: скриншоты уходят второму внешнему сервису; ключ в Authorization-заголовке | Medium | ✅ Контроль: Groq включается только при недоступности Gemini; ключ только в Script Properties; модель — whitelist через `GROQ_MODEL` (только vision-модели); запрос не логируется |
| F14 | Formula-injection через `/alias` (пользовательские значения → ячейки Settings) | Low | ✅ Исправлено: `cmdAlias_` отклоняет значения, начинающиеся с `= + - @`, и длиннее 40 символов |
| F15 | Журналирование (Ops_Log, консоль, сообщения об ошибках) | Low | ✅ Контроль: grep-проверка — токены/ключи не логируются; текст журнала проходит `safeCellText_`; ошибки наружу — только сообщение без стека и секретов |
| F16 | Бэкапы: zip с CSV всех данных покидает Google (Telegram-чат; опц. приватный репозиторий GitHub) | Medium | ✅ Контроль: получатель — только чат владельца (whitelist) / приватное репо; токен GitHub — узкий scope `Contents` одного репо, только в Script Properties; внутри zip нет секретов (токены живут в Script Properties и не выгружаются); в §5 добавлена ротация GH-токена |
| R1 | **Остаточный риск**: при незаданном `TMA_READ_TOKEN` чтение открыто | Medium | ✅ Решено: токен создаётся автоматически при первом `setup()`/`createSpreadsheet`; ссылку с токеном возвращает `getAccessInfo()`, команда `/app` подставляет его сама |
| R2 | **Остаточный риск**: URL развёртывания GAS — сам по себе секрет (bearer) | Low | Не переиспользовать развёртывание в публичных местах; перевыпускать при компрометации (Управление развёртываниями → новое) |
| R3 | Права на таблицу в Drive | Info | Доступ к редактированию — только аккаунту владельца; не включать «все по ссылке» на запись |

**Ранний аудит на этапе разработки** (до этого ревью) уже устранил: чтение состояния долгов за пределами строк 2–3 листа, перезапись строк ипотек в реестре, неконсистентность replay-журнала.

### 3. Рантайм-аудит — запускайте периодически

В редакторе Apps Script выполните функцию **`securityAudit()`** (файл `SecurityAudit.gs`). Она проверяет: наличие/длину всех секретов, валидность токена бота (`getMe`), валидность ключа Gemini (дешёвый запрос списка моделей), привязку и ошибки webhook, доступ к таблице — и присылает отчёт владельцу в Telegram.

### 4. Секреты и git

**Принцип: секреты живут в Script Properties Apps Script и в локальном `secrets.json`, который никогда не коммитится.**

#### Файлы репозитория

| Файл | Роль |
|------|------|
| `.gitignore` | исключает `secrets.json`, `.env`, `.clasp.json`, `.clasprc.json` |
| `secrets.example.json` | шаблон ключей без реальных значений |
| `scripts/hooks/pre-commit` + `scripts/install-hooks.sh` | хук, блокирующий коммит с похожим на секрет фрагментом |
| `.gitleaks.toml` | правила для сканера [gitleaks](https://github.com/gitleaks/gitleaks): токен Telegram `\d{8,10}:[A-Za-z0-9_-]{35}`, ключ Google `AIza…`, явные присваивания `*_SECRET=...` |

#### Первичная настройка

```bash
cd budget-calculator
git init
bash scripts/install-hooks.sh        # поставить pre-commit хук
cp secrets.example.json secrets.json   # локально, НЕ коммитить
# заполните secrets.json, перенесите значения в Script Properties (SETUP.md, Шаг 3)
```

#### Вариант с git-secrets (awslabs)

Если предпочитаете [git-secrets](https://github.com/awslabs/git-secrets):

```bash
git secrets --install
git secrets --add '\b\d{8,10}:[A-Za-z0-9_-]{35}\b'   # токен Telegram
git secrets --add '\bAIza[0-9A-Za-z_\-]{30,}\b'      # ключ Google
git secrets --add '(WEBHOOK_SECRET|TMA_READ_TOKEN)\s*=\s*\S{16,}'
git secrets --register-aws                            # опционально
```

#### Проверка истории

```bash
gitleaks detect -c .gitleaks.toml --redact   # по всем коммитам
gitleaks protect --staged --redact -c .gitleaks.toml   # по индексу
```

### 5. Что делать при утечке секрета

| Утечка | Действие |
|--------|----------|
| Токен бота | @BotFather → `/mybots` → бот → API Token → **Revoke** (старый умрёт мгновенно) → новый в Script Properties → `setupWebhook()` заново |
| Ключ Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → удалить ключ → создать новый → обновить Script Properties |
| URL Web App / read_token | Apps Script → Управление развёртываниями → **новое развёртывание** (старый URL отомрёт) → `setupWebhook()` + обновить `API_URL`/ссылку Mini App |
| Токен GitHub (GH_BACKUP_TOKEN) | [github.com/settings/tokens](https://github.com/settings/tokens) → Delete у скомпрометированного → новый в Script Properties (бэкапы перестанут дублироваться, пока не обновите) |
| Таблица | Файл → Настройки доступа → убрать лишних → при необходимости «История версий» для отката |

После любой ротации: выполнить `securityAudit()` и убедиться, что все пункты ✅.

### 6. Чек-лист перед продакшеном

- [ ] 3 секрета в Script Properties (токен бота, chat_id, ключ Gemini); `WEBHOOK_SECRET` и `TMA_READ_TOKEN` сгенерированы автоматически при `setup()` (проверка: `securityAudit()`)
- [ ] Mini App открывается из Telegram (`/app`); ссылка для браузера — `getAccessInfo()`
- [ ] `securityAudit()` — все ✅, отчёт пришёл в Telegram
- [ ] Таблица в Drive: доступ по ссылке — выключен (или только просмотр для себя)
- [ ] Репозиторий: `bash scripts/install-hooks.sh` выполнен, `git status` не видит `secrets.json`
- [ ] `gitleaks detect` по истории — пусто
