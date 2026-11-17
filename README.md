# 💰 Budget Companion — Telegram-бот и Mini App личных финансов

[![CI](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/ci.yml/badge.svg)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/ci.yml)
[![Deploy (Cloudflare)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/deploy-v2.yml/badge.svg)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/deploy-v2.yml)

Мультипользовательский движок личных финансов: Telegram-бот (команды, кнопки,
напоминания) + Mini App (Preact SPA) поверх Cloudflare Workers + D1.
**TCO: $0/мес** — Workers Free, D1 Free, Frankfurter без ключа,
Gemini/Groq free tier, Telegram Bot API бесплатен.

> Legacy-стек (Google Apps Script + Google Sheets) удалён на шаге 9 миграции
> ([ADR-0001](docs/adr/0001-platform-and-architecture.md)). Эталоны его
> математики живут как golden-фикстура `apps/api/test/domain/golden.legacy.json`.

## Возможности

| # | Модуль | Что делает |
|---|--------|-----------|
| 1 | **Бюджет** | `/plan` — водопад месяца: доход → обязательства → лимит «на жизнь» → профицит; `/spent`, `/week` — траты недели, burn rate, дневной остаток |
| 2 | **Регулярные платежи** | Квартплата/интернет/алименты: напоминания за 2 дня, **автопроводка** в день платежа в отдельный журнал (не ест недельный лимит), «оплачено» одной кнопкой |
| 3 | **Кредиты и ипотеки** | Журнал событий (платёж / ЧДП «платёж↓ или срок↓» / сверка), replay → остаток и проекция погашения; автоплатёж по графику; правки ставки/платежа/дня |
| 4 | **Долги людям** | Займы в обе стороны, сроки и напоминания, частичные возвраты |
| 5 | **Vision** | Скриншот банковского приложения → Gemini (резерв Groq) → недельная трата или сверка остатка кредита кнопкой. Opt-in в профиле, 20 скринов/день |
| 6 | **Валюты (/fx)** | 180-дневная история Frankfurter → перцентиль, RSI(14), SMA-тренд, прогноз ±σ√h на 7/30д, рекомендации «менять / частями / ждать»; push-алерты при входе в топ/низ-зону (кулдаун неделя); журнал фактических обменов с рыночным курсом |
| 7 | **Мультипользователь** | Владелец + участники по одноразовым ссылкам `/invite`; изоляция данных по tenant |
| 8 | **Инвестиции (ручной портфель)** | `/invest` — итог портфеля в валюте бюджета и доли по видам (вклады, облигации, крипта, акции, другое) против целей. Позиции вводятся в Mini App (плитка «Инвестиции» на главной). Цены вручную, а для крипты из белого списка монет можно включить автоцены с CoinGecko (opt-in в профиле; ручная цена остаётся запасной). Это учёт, а не инвестиционная рекомендация |

## Архитектура

```
                ┌──────────────┐
                │   Telegram   │
                │ бот+Mini App │
                └──────┬───────┘
             webhook   │  REST /api/tma (Bearer JWT)
                       ▼
        ┌──────────────────────────────┐
        │  Cloudflare Worker (Hono)    │
        │  • /telegram — webhook бота  │
        │  • /api/tma — Mini App API   │
        │  • /health                   │
        │  • cron 0 * * * * — напоминания,
        │    автопроводки, FX-алерты   │
        │  • [assets] — SPA из web/dist│
        └──┬────────┬────────┬─────────┘
           ▼        ▼        ▼
        ┌─────┐ ┌────────┐ ┌──────────┐
        │ D1  │ │Frankfur│ │ Gemini / │
        │(БД) │ │ter (FX)│ │ Groq     │
        └─────┘ └────────┘ └──────────┘
```

Подробно — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Быстрый старт

Предусловия: **Node.js ≥ 20**, бесплатный аккаунт
[dash.cloudflare.com](https://dash.cloudflare.com), токен бота от @BotFather.

```bash
npm ci                          # зависимости всех workspaces
npm run wrangler -- login       # вход в Cloudflare (браузер), один раз
```

Один раз — создать базу и вписать `database_id` в `apps/api/wrangler.toml`:

```bash
npm run wrangler -- d1 create budget-companion
```

Дальше всё делает мастер (токен BotFather → миграции D1 → деплой → секреты
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`/`JWT_SECRET`/`OWNER_TELEGRAM_ID` →
webhook → menu-button):

```bash
npm run setup                   # --dry-run — только план
```

После мастера напишите боту `/start` — вы зарегистрированы владельцем;
`/invite` создаёт одноразовую ссылку-приглашение для участников.

**Локальная разработка:**

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars   # секреты для wrangler dev (в .gitignore)
npm run dev -w apps/api                            # локальный воркер + D1 (miniflare)
npm run wrangler -- d1 migrations apply DB --local # миграции в локальную D1
npm run check                                      # lint + typecheck + тесты API + сборка web
```

**Релиз:**

```bash
npm run release    # проверки → сборка apps/web → миграции D1 → wrangler deploy → /health
```

**Mini App:** голубая menu-button **«💰 Бюджет»** у поля ввода
(`setChatMenuButton`, ставится мастером; вручную —
`node scripts/telegram-webhook.mjs menu <url>`).

**Опциональные секреты** (`npm run wrangler -- secret put <ИМЯ>`):
`GEMINI_API_KEY` (+`GEMINI_MODEL`), `GROQ_API_KEY` (+`GROQ_MODEL`) — vision;
без них распознавание скриншотов вежливо отвечает «не настроено».
`COINGECKO_API_KEY` — автоцены крипты в портфеле (Demo-ключ CoinGecko; без него цены ручные).
Инструкция — [docs/v2-development.md](docs/v2-development.md).

## Структура проекта

```
budget-calculator/
├── README.md                  ← вы здесь
├── AGENTS.md                  правила для ИИ-агентов и автоматизации
├── CONTRIBUTING.md            команды и правила разработки
├── SECURITY.md                модель угроз и политика секретов
├── AUDIT_REPORT.md            отчёт аудита (все находки закрыты)
├── CHANGELOG.md               история изменений
├── package.json               npm-скрипты: check / test / release / setup
├── docs/
│   ├── ARCHITECTURE.md        карта системы (диаграммы, данные, деплой)
│   ├── USER_GUIDE.md          гид пользователя (команды, экраны, FAQ)
│   ├── v2-development.md      разработка и деплой
│   ├── ux/navigation.md       навигация бота (источник истины + реестр экранов)
│   └── adr/                   архитектурные решения (ADR-0001: платформа)
├── apps/
│   ├── api/                   Cloudflare Worker — Hono-роутер, D1, cron
│   │   ├── migrations/        SQL-миграции D1 (иммутабельны, wrangler d1 migrations)
│   │   ├── src/               http/ services/ bot/ tma/ domain/ db/ fx/ vision/ telegram/
│   │   ├── test/              vitest в рантайме workerd с локальной D1
│   │   └── wrangler.toml      биндинги D1, [assets] SPA, [triggers] cron, [vars]
│   └── web/                   Mini App на Preact (Vite) → dist → Static Assets
├── scripts/
│   ├── setup.mjs              мастер подключения бота (npm run setup)
│   ├── release.mjs            релиз — проверки → web → миграции → deploy
│   ├── telegram-webhook.mjs   webhook set/info/delete + menu-button
│   ├── install-hooks.js/.sh   установка pre-commit хука (авто при npm install)
│   └── hooks/pre-commit       блокирует коммит с токенами/ключами + eslint
└── .github/workflows/         CI: lint+typecheck+tests+gitleaks; CD: Cloudflare
```

## Документация

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — гид пользователя: команды,
  сценарии (кредиты, ЧДП, сверка, автоплатежи, vision, обмены), FAQ
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — диаграммы, таблицы D1, деплой
- [docs/v2-development.md](docs/v2-development.md) — разработка, вехи, деплой,
  ручные чеклисты
- [SECURITY.md](SECURITY.md) — модель угроз, изоляция tenant, политика секретов
- [SETUP.md](SETUP.md) — установка с нуля (то же, что «Быстрый старт», подробнее)
