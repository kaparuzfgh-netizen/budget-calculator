# 🔐 SECURITY.md — аудит безопасности и политика секретов

Дата аудита: 2026-10-24 · Код: `apps-script/` + `mini-app/index.html`

## 1. Модель угроз

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

## 2. Отчёт аудита (что проверено и исправлено)

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

## 3. Рантайм-аудит — запускайте периодически

В редакторе Apps Script выполните функцию **`securityAudit()`** (файл `SecurityAudit.gs`). Она проверяет: наличие/длину всех секретов, валидность токена бота (`getMe`), валидность ключа Gemini (дешёвый запрос списка моделей), привязку и ошибки webhook, доступ к таблице — и присылает отчёт владельцу в Telegram.

## 4. Секреты и git

**Принцип: секреты живут в Script Properties Apps Script и в локальном `secrets.json`, который никогда не коммитится.**

### Файлы репозитория

| Файл | Роль |
|------|------|
| `.gitignore` | исключает `secrets.json`, `.env`, `.clasp.json`, `.clasprc.json` |
| `apps-script/secrets.example.json` | шаблон ключей без реальных значений |
| `scripts/hooks/pre-commit` + `scripts/install-hooks.sh` | хук, блокирующий коммит с похожим на секрет фрагментом |
| `.gitleaks.toml` | правила для сканера [gitleaks](https://github.com/gitleaks/gitleaks): токен Telegram `\d{8,10}:[A-Za-z0-9_-]{35}`, ключ Google `AIza…`, явные присваивания `*_SECRET=...` |

### Первичная настройка

```bash
cd budget-calculator
git init
bash scripts/install-hooks.sh        # поставить pre-commit хук
cp apps-script/secrets.example.json apps-script/secrets.json   # локально, НЕ коммитить
# заполните secrets.json, перенесите значения в Script Properties (SETUP.md, Шаг 3)
```

### Вариант с git-secrets (awslabs)

Если предпочитаете [git-secrets](https://github.com/awslabs/git-secrets):

```bash
git secrets --install
git secrets --add '\b\d{8,10}:[A-Za-z0-9_-]{35}\b'   # токен Telegram
git secrets --add '\bAIza[0-9A-Za-z_\-]{30,}\b'      # ключ Google
git secrets --add '(WEBHOOK_SECRET|TMA_READ_TOKEN)\s*=\s*\S{16,}'
git secrets --register-aws                            # опционально
```

### Проверка истории

```bash
gitleaks detect -c .gitleaks.toml --redact   # по всем коммитам
gitleaks protect --staged --redact -c .gitleaks.toml   # по индексу
```

## 5. Что делать при утечке секрета

| Утечка | Действие |
|--------|----------|
| Токен бота | @BotFather → `/mybots` → бот → API Token → **Revoke** (старый умрёт мгновенно) → новый в Script Properties → `setupWebhook()` заново |
| Ключ Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → удалить ключ → создать новый → обновить Script Properties |
| URL Web App / read_token | Apps Script → Управление развёртываниями → **новое развёртывание** (старый URL отомрёт) → `setupWebhook()` + обновить `API_URL`/ссылку Mini App |
| Токен GitHub (GH_BACKUP_TOKEN) | [github.com/settings/tokens](https://github.com/settings/tokens) → Delete у скомпрометированного → новый в Script Properties (бэкапы перестанут дублироваться, пока не обновите) |
| Таблица | Файл → Настройки доступа → убрать лишних → при необходимости «История версий» для отката |

После любой ротации: выполнить `securityAudit()` и убедиться, что все пункты ✅.

## 6. Чек-лист перед продакшеном

- [ ] 3 секрета в Script Properties (токен бота, chat_id, ключ Gemini); `WEBHOOK_SECRET` и `TMA_READ_TOKEN` сгенерированы автоматически при `setup()` (проверка: `securityAudit()`)
- [ ] Mini App открывается из Telegram (`/app`); ссылка для браузера — `getAccessInfo()`
- [ ] `securityAudit()` — все ✅, отчёт пришёл в Telegram
- [ ] Таблица в Drive: доступ по ссылке — выключен (или только просмотр для себя)
- [ ] Репозиторий: `bash scripts/install-hooks.sh` выполнен, `git status` не видит `secrets.json`
- [ ] `gitleaks detect` по истории — пусто
