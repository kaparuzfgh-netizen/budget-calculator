# 🚀 Установка

~15 минут. Нужны: Node.js ≥ 20, бесплатный аккаунт Cloudflare, Telegram.

## Шаг 1 · 2 мин — бот и ваш ID

1. В Telegram: [@BotFather](https://t.me/BotFather) → `/newbot` → имя →
   username (оканчивается на `bot`) → скопируйте **токен** `123456789:AAH...`.
2. [@userinfobot](https://t.me/userinfobot) → напишите что угодно → он ответит
   вашим **chat_id** (число).

## Шаг 2 · 2 мин — зависимости и вход в Cloudflare

```bash
npm ci
npm run wrangler -- login       # откроется браузер
```

## Шаг 3 · 1 мин — база D1

```bash
npm run wrangler -- d1 create budget-companion
```

Скопируйте `database_id` из вывода в `apps/api/wrangler.toml`
(секция `[[d1_databases]]`).

## Шаг 4 · 5 мин — мастер

```bash
npm run setup                   # --dry-run — только план
```

Мастер спросит токен BotFather и chat_id, затем сам сделает всё:
миграции D1 → деплой воркера → секреты (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET`, `OWNER_TELEGRAM_ID`) → регистрация
webhook → menu-button «💰 Бюджет».

## Шаг 5 · 1 мин — проверка

- Напишите боту `/start` → онбординг профиля (доход, валюты, лимит).
- `/menu` — главное меню; голубая кнопка у поля ввода открывает Mini App.
- `/invite` — одноразовая ссылка для участника.

## Опционально — vision (скриншоты банка)

```bash
npm run wrangler -- secret put GEMINI_API_KEY   # ключ с aistudio.google.com/apikey
npm run wrangler -- secret put GROQ_API_KEY     # резерв, console.groq.com
```

Без ключей функция вежливо отвечает «не настроено». Включается у пользователя
в Профиль → Напоминания → «📷 Скриншоты».

## Релизы

```bash
npm run release    # проверки → сборка web → миграции → deploy → /health
```

CI/CD: push в `main` → workflow **Deploy v2** (нужны секреты репозитория
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — без них деплой-джоб
пропускается с notice). Подробно — [docs/v2-development.md](docs/v2-development.md).

## Частые проблемы

| Симптом | Причина и решение |
|---------|-------------------|
| `wrangler` не распознаётся | он локальный — через `npm run wrangler -- <команда>` |
| `secret put` не находит воркера | запускайте через `npm run wrangler` (cwd = apps/api, там wrangler.toml) |
| Бот молчит после деплоя | `npm run webhook:info` — webhook должен указывать на `/telegram` и иметь secret-token; мастер ставит сам |
| Mini App 401 / «not onboarded» | `/start` боту; JWT живёт 12ч — просто переоткройте Mini App |
| vision «не настроено» | не задан `GEMINI_API_KEY`/`GROQ_API_KEY` (см. выше) или выключено в профиле |

## DATA_KEY (шифрование данных)

`npm run setup` генерирует `DATA_KEY` (base64, 32 байта) при первом запуске и
печатает его ОДИН РАЗ — сохраните в менеджере паролей. Потеря ключа = данные в D1
необратимо не расшифровать. Вручную: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
затем `npm run wrangler -- secret put DATA_KEY`. Локально — в `apps/api/.dev.vars`.
Без ключа /telegram/* и /api/tma/* отвечают 503 (fail-closed).
