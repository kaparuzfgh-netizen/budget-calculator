/**
 * tw.tsx — демо-просмотр НАСТОЯЩИХ экранов Mini App в обычном браузере:
 * `?demo=home|week|income|profile|categories` рендерит реальный экран
 * поверх stub-Api (фикстуры из ./mock.ts) и stub-Nav. Без Telegram и auth;
 * загружается dynamic import'ом — в прод-бандл не попадает.
 * Мутации применяются к фикстурам в памяти — формы и тоглы «живые».
 */
import { render } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { Check } from 'lucide-preact';
import type { Api, Commitment } from '../api';
import type { Nav } from '../app';
import type { ScreenProps } from '../app';
import { flashCls, mutedCls } from '../ui';
import { HomeScreen, type TempoKind } from '../screens/home';
import { WeekScreen } from '../screens/week';
import { IncomeScreen } from '../screens/income';
import { ProfileScreen } from '../screens/profile';
import { CategoriesScreen } from '../screens/categories';
import { CATEGORIES, COMMITMENTS, EXPENSES, INCOME, OVERVIEW, PROFILE, UPCOMING, tempoWeek } from './mock';

// сценарий темпа: ?demo=home&pace=low|ok|over; вариант графика: &chart=line|thermo|gauge|heat
const PACE_LABELS = { low: 'мало', ok: 'средне', over: 'перебор' } as const;
const PACE = ((): keyof typeof PACE_LABELS => {
  const p = new URLSearchParams(location.search).get('pace');
  return p === 'low' || p === 'over' ? p : 'ok';
})();
const WEEK = tempoWeek(PACE);

const CHART_LABELS = { line: 'линия', thermo: 'термометр', gauge: 'шкала', heat: 'карта', race: 'гонка' } as const;
const CHART = ((): TempoKind => {
  const p = new URLSearchParams(location.search).get('chart');
  return p === 'thermo' || p === 'gauge' || p === 'heat' || p === 'race' ? p : 'line';
})();

// ── stub Api: GET — фикстуры; мутации — правка фикстур в памяти ──

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
const matchId = (path: string, re: RegExp): number | null => {
  const m = re.exec(path);
  return m ? Number(m[1]) : null;
};

function applyPatch(path: string, body: Record<string, unknown>): void {
  if (path === '/api/tma/profile') {
    if (typeof body.typical_income === 'number') PROFILE.typical_income_minor = num(body.typical_income) ?? 0;
    if (typeof body.income_currency === 'string') PROFILE.income_currency = body.income_currency;
    if (typeof body.living_cap === 'number') {
      PROFILE.living_cap_minor = num(body.living_cap) ?? 0;
      PROFILE.weekly_budget_minor = num((body.living_cap * 12) / 52) ?? 0;
    }
    if (typeof body.living_currency === 'string') PROFILE.living_currency = body.living_currency;
    if ('expense_currency' in body) PROFILE.expense_currency = (body.expense_currency as string | null) ?? null;
    if (typeof body.timezone === 'string') PROFILE.timezone = body.timezone;
    for (const k of ['reminders_weekly', 'reminders_payments', 'fx_alerts_enabled', 'vision_enabled'] as const) {
      if (k in body) PROFILE[k] = body[k] ? 1 : 0;
    }
    return;
  }
  let id = matchId(path, /^\/api\/tma\/commitments\/(\d+)$/);
  if (id !== null) {
    const c = COMMITMENTS.commitments.find((x) => x.id === id);
    if (!c) return;
    if (typeof body.name === 'string') c.name = body.name;
    if (typeof body.amount === 'number') c.amount_minor = num(body.amount) ?? c.amount_minor;
    if (typeof body.currency === 'string') c.currency = body.currency;
    if ('due_day' in body) c.due_day = (body.due_day as number | null) ?? null;
    if ('anchor_on' in body) c.anchor_on = (body.anchor_on as string | null) ?? null;
    if ('every_months' in body) c.every_months = (body.every_months as number | null) ?? 1;
    if ('active' in body) c.active = body.active ? 1 : 0;
    return;
  }
  id = matchId(path, /^\/api\/tma\/expenses\/(\d+)$/);
  if (id !== null) {
    const e = EXPENSES.expenses.find((x) => x.id === id);
    if (!e) return;
    if (typeof body.amount === 'number') e.amount_minor = num(body.amount) ?? e.amount_minor;
    if (typeof body.currency === 'string') e.currency = body.currency;
    if ('note' in body) e.note = (body.note as string | null) ?? null;
    if ('category_id' in body) e.category_id = (body.category_id as number | null) ?? null;
    if (typeof body.spent_on === 'string') e.spent_on = body.spent_on;
    return;
  }
  id = matchId(path, /^\/api\/tma\/categories\/(\d+)$/);
  if (id !== null) {
    const c = CATEGORIES.categories.find((x) => x.id === id);
    if (!c) return;
    if (typeof body.name === 'string') c.name = body.name;
    if (typeof body.emoji === 'string') c.emoji = body.emoji;
    if (typeof body.archived === 'boolean') c.archived = body.archived;
  }
}

function applyPost(path: string, body: Record<string, unknown>): void {
  if (path === '/api/tma/expenses') {
    EXPENSES.expenses.unshift({
      id: Math.max(0, ...EXPENSES.expenses.map((x) => x.id)) + 1,
      spent_on: (body.spent_on as string) ?? EXPENSES.week_start,
      amount_minor: num(body.amount) ?? 0,
      currency: (body.currency as string) ?? PROFILE.expense_currency ?? 'KGS',
      note: (body.note as string | null) ?? null,
      category_id: (body.category_id as number | null) ?? null,
    });
    return;
  }
  if (path === '/api/tma/income') {
    const amount = num(body.amount) ?? 0;
    INCOME.entries.unshift({
      id: Math.max(0, ...INCOME.entries.map((x) => x.id)) + 1,
      amount_minor: amount,
      currency: (body.currency as string) ?? PROFILE.income_currency ?? 'EUR',
      note: (body.note as string | null) ?? null,
      received_on: (body.received_on as string | null) ?? null,
    });
    INCOME.total_minor += amount;
    return;
  }
  if (path === '/api/tma/commitments') {
    COMMITMENTS.commitments.push({
      id: Math.max(0, ...COMMITMENTS.commitments.map((x) => x.id)) + 1,
      name: (body.name as string) ?? 'Платёж',
      amount_minor: num(body.amount) ?? 0,
      currency: (body.currency as string) ?? 'USD',
      due_day: (body.due_day as number | null) ?? null,
      frequency: (body.frequency as Commitment['frequency']) ?? 'monthly',
      interval_days: (body.interval_days as number | null) ?? null,
      anchor_on: (body.anchor_on as string | null) ?? null,
      due_month: (body.due_month as number | null) ?? null,
      every_months: (body.every_months as number | null) ?? 1,
      cadence: '1 числа',
      next_due_on: null,
      active: 1,
      paid_this_month: false,
      last_paid_on: null,
    });
    return;
  }
  const m = /^\/api\/tma\/(commitments|debts)\/(\d+)\/(payments|events)$/.exec(path);
  if (m) {
    // «Оплатить» на главной: commitment → paid_this_month; debt → флаг в upcoming
    const id = Number(m[2]);
    if (m[1] === 'commitments') {
      const c = COMMITMENTS.commitments.find((x) => x.id === id);
      if (c) {
        c.paid_this_month = true;
        c.last_paid_on = '2026-03-18';
      }
    }
    const u = UPCOMING.items.find((x) => x.id === id && (m[1] === 'commitments' ? x.kind === 'commitment' : x.kind === 'debt'));
    if (u) u.paid = true;
    return;
  }
  if (path === '/api/tma/categories') {
    CATEGORIES.categories.push({
      id: Math.max(0, ...CATEGORIES.categories.map((x) => x.id)) + 1,
      name: (body.name as string) ?? 'Категория',
      emoji: (body.emoji as string) ?? '📦',
      preset_key: null,
      archived: false,
      sort: Math.max(0, ...CATEGORIES.categories.map((x) => x.sort)) + 1,
    });
  }
}

function applyDel(path: string): void {
  let id = matchId(path, /^\/api\/tma\/expenses\/(\d+)$/);
  if (id !== null) {
    EXPENSES.expenses = EXPENSES.expenses.filter((x) => x.id !== id);
    return;
  }
  id = matchId(path, /^\/api\/tma\/income\/(\d+)$/);
  if (id !== null) {
    const e = INCOME.entries.find((x) => x.id === id);
    if (e) INCOME.total_minor -= e.amount_minor;
    INCOME.entries = INCOME.entries.filter((x) => x.id !== id);
    return;
  }
  id = matchId(path, /^\/api\/tma\/commitments\/(\d+)$/);
  if (id !== null) {
    COMMITMENTS.commitments = COMMITMENTS.commitments.filter((x) => x.id !== id);
    return;
  }
  id = matchId(path, /^\/api\/tma\/categories\/(\d+)$/);
  if (id !== null) {
    CATEGORIES.categories = CATEGORIES.categories.filter((x) => x.id !== id);
  }
}

const stubApi: Api = {
  get: <T,>(path: string): Promise<T> => {
    console.log('[demo] GET', path);
    const base = path.split('?')[0]!;
    const all = new URLSearchParams(path.split('?')[1] ?? '').get('all');
    const routes: Record<string, unknown> = {
      '/api/tma/overview': OVERVIEW,
      '/api/tma/week': WEEK,
      '/api/tma/upcoming': UPCOMING,
      '/api/tma/expenses': EXPENSES,
      '/api/tma/income': INCOME,
      '/api/tma/profile': PROFILE,
      '/api/tma/commitments': COMMITMENTS,
      '/api/tma/categories': all
        ? CATEGORIES
        : { categories: CATEGORIES.categories.filter((x) => !x.archived) },
    };
    return Promise.resolve(routes[base] ?? {}) as Promise<T>;
  },
  post: <T,>(path: string, body?: unknown): Promise<T> => {
    console.log('[demo] POST', path, body);
    applyPost(path, (body ?? {}) as Record<string, unknown>);
    return Promise.resolve({ ok: true }) as Promise<T>;
  },
  patch: <T,>(path: string, body?: unknown): Promise<T> => {
    console.log('[demo] PATCH', path, body);
    applyPatch(path, (body ?? {}) as Record<string, unknown>);
    return Promise.resolve({ ok: true }) as Promise<T>;
  },
  del: <T,>(path: string): Promise<T> => {
    console.log('[demo] DEL', path);
    applyDel(path);
    return Promise.resolve({ ok: true }) as Promise<T>;
  },
  postRaw: <T,>(path: string): Promise<T> => {
    console.log('[demo] POST (raw)', path);
    // «разобранный» скриншот — шторка проверки в демо
    return Promise.resolve({
      ok: true,
      result: {
        provider: 'gemini',
        screen_type: 'expense_analytics',
        period: 'неделя',
        total_spent: 1240,
        currency: 'RUB',
        top_categories: [],
        is_full_month_analytics: false,
        bank: 'Демо-банк',
        debt_balance: 0,
        transactions: [
          { date: null, amount: 540, note: 'Продукты', category: '' },
          { date: null, amount: 700, note: 'Кафе', category: '' },
        ],
      },
    }) as Promise<T>;
  },
  getBlob: (path) => {
    console.log('[demo] GET (blob)', path);
    return Promise.resolve(new Blob([JSON.stringify({ demo: true })], { type: 'application/json' }));
  },
};

// ── stub Nav + оболочка ──

const SCREENS = ['home', 'week', 'income', 'profile', 'categories'] as const;
type DemoName = (typeof SCREENS)[number];

function DemoApp({ name }: { name: string }) {
  const [flash, setFlash] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nav: Nav = {
    push: (r) => console.log('[demo] nav.push', r),
    back: () => console.log('[demo] nav.back'),
    home: () => console.log('[demo] nav.home'),
    flash: (msg) => {
      if (timer.current) clearTimeout(timer.current);
      setFlash(msg);
      timer.current = setTimeout(() => setFlash(null), 3000);
    },
  };
  const onFatal = () => console.log('[demo] onFatal');
  const props: ScreenProps = { api: stubApi, nav, onFatal };

  const screen =
    name === 'home' ? (
      <HomeScreen {...props} name="Демо" tempo={CHART} />
    ) : name === 'week' ? (
      <WeekScreen {...props} />
    ) : name === 'income' ? (
      <IncomeScreen {...props} />
    ) : name === 'profile' ? (
      <ProfileScreen {...props} />
    ) : name === 'categories' ? (
      <CategoriesScreen {...props} />
    ) : (
      <div>
        <h1 class="mb-3 text-xl font-semibold tracking-tight">Демо-экраны</h1>
        <p class={mutedCls}>Неизвестное демо «{name}». Доступны:</p>
        <ul class="mt-2 list-disc pl-5 text-sky-400">
          {SCREENS.map((s) => (
            <li key={s}>
              <a class="underline" href={`?demo=${s}`}>
                ?demo={s}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div class="mx-auto max-w-md px-4 pb-10 pt-6">
      <p class="mb-4 text-[11px] uppercase tracking-wider text-zinc-600">
        demo · {name} — данные из demo/mock.ts
      </p>
      {name === 'home' && (
        <div class="mb-4 space-y-1 text-[11px] text-zinc-500">
          <p class="flex items-center gap-3">
            темп:
            {(Object.keys(PACE_LABELS) as (keyof typeof PACE_LABELS)[]).map((p) => (
              <a
                key={p}
                href={`?demo=home&pace=${p}${CHART === 'line' ? '' : `&chart=${CHART}`}`}
                class={p === PACE ? 'font-medium text-sky-400' : 'underline'}
              >
                {PACE_LABELS[p]}
              </a>
            ))}
          </p>
          <p class="flex items-center gap-3">
            график:
            {(Object.keys(CHART_LABELS) as (keyof typeof CHART_LABELS)[]).map((k) => (
              <a
                key={k}
                href={`?demo=home&pace=${PACE}${k === 'line' ? '' : `&chart=${k}`}`}
                class={k === CHART ? 'font-medium text-sky-400' : 'underline'}
              >
                {CHART_LABELS[k]}
              </a>
            ))}
          </p>
        </div>
      )}
      {flash !== null && (
        <div class={flashCls}>
          <Check size={16} strokeWidth={1.5} /> {flash}
        </div>
      )}
      {screen}
    </div>
  );
}

/** Точка входа из main.tsx: ?demo=<экран> → render нужного экрана. */
export function mountDemo(name: string, rootEl: HTMLElement): void {
  // старые ссылки ?demo=tw/?demo=tg вели на прототип «Профиля»
  const alias: Record<string, DemoName> = { tw: 'profile', tg: 'profile' };
  render(<DemoApp name={alias[name] ?? name} />, rootEl);
}
