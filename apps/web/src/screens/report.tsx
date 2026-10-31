/**
 * report.tsx — экран «Отчёты»: период/сдвиг, сводные плитки,
 * «распределение расходов» (стек-бар + норма), категории, интерактивная
 * динамика (тап по столбику → детали), крупные траты (топ + выбросы
 * по медиане категории). Валюта — свои чипы + «＋» с закреплением.
 * Данные: GET /api/tma/report?period&offset&ccy (minor units).
 */
import { useState } from 'preact/hooks';
import {
  ChartColumn,
  ChartPie,
  ChevronLeft,
  ChevronRight,
  Plus,
  Receipt,
  Tags,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-preact';
import type { DebtsList, Profile, Report, ReportPeriod } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinorAuto } from '../fmt';
import {
  cardCls,
  CcySelect,
  ErrorView,
  errorView,
  h1Cls,
  headCls,
  Info,
  liCls,
  listCardCls,
  Loading,
  mutedCls,
  rowCls,
  useData,
} from '../ui';

const PERIODS: { p: ReportPeriod; label: string }[] = [
  { p: 'week', label: 'Неделя' },
  { p: 'month', label: 'Месяц' },
  { p: 'quarter', label: 'Квартал' },
  { p: 'half', label: 'Полгода' },
  { p: 'year', label: 'Год' },
];
const COLORS = { living: '#5288c1', commitments: '#e8a33d', credits: '#a06ad4', loans: '#d4708a' };

/** Валюты, закреплённые пользователем через «＋», — localStorage (≤5). */
const CCY_KEY = 'report_ccys_v1';
const loadCustomCcys = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CCY_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && /^[A-Z]{3,5}$/.test(x)).slice(0, 5)
      : [];
  } catch {
    return [];
  }
};
const saveCustomCcys = (xs: readonly string[]) => {
  try {
    localStorage.setItem(CCY_KEY, JSON.stringify(xs));
  } catch {
    /* private mode — закрепление просто не запоминается */
  }
};

const chipCls =
  'rounded-full border border-white/10 bg-zinc-900 px-3.5 py-2 text-[13px] text-zinc-300 transition hover:border-white/20';
const chipOnCls =
  'rounded-full border border-sky-500/60 bg-sky-500/15 px-3.5 py-2 text-[13px] text-sky-300';

export function ReportScreen({ api, nav, onFatal }: ScreenProps) {
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [offset, setOffset] = useState(0);
  // null → валюта дохода из профиля (дефолт отчёта)
  const [ccy, setCcy] = useState<string | null>(null);
  const [customCcys, setCustomCcys] = useState<string[]>(loadCustomCcys);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickVal, setPickVal] = useState('');
  const [selB, setSelB] = useState<string | null>(null);
  const prof = useData(() => api.get<Profile>('/api/tma/profile'), onFatal, []);
  const debts = useData(() => api.get<DebtsList>('/api/tma/debts'), onFatal, []);
  const sel = ccy ?? prof.data?.income_currency ?? null;
  const rep = useData(
    async () =>
      sel === null
        ? undefined
        : api.get<Report>(`/api/tma/report?period=${period}&offset=${offset}&ccy=${sel}`),
    onFatal,
    [period, offset, sel],
  );
  // чипы = свои валюты (профиль + долги + закреплённые через «＋»), по центру
  const chipCcys = [
    ...new Set(
      [
        prof.data?.income_currency,
        prof.data?.living_currency,
        prof.data?.base_currency,
        prof.data?.expense_currency,
        ...customCcys,
        ...(debts.data?.debts.map((d) => d.currency) ?? []),
      ].filter((x): x is string => !!x),
    ),
  ].slice(0, 9);
  if (sel && !chipCcys.includes(sel)) chipCcys.unshift(sel);

  /** Выбор в пикере «＋» → чип закрепляется в наборе и становится валютой отчёта. */
  const addCcy = (v: string) => {
    const code = v.trim().toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(code)) return;
    setCcy(code);
    if (!chipCcys.includes(code)) {
      const next = [code, ...customCcys.filter((x) => x !== code)].slice(0, 5);
      setCustomCcys(next);
      saveCustomCcys(next);
    }
    setPickVal('');
    setPickerOpen(false);
  };

  /** «×» на закреплённом чипе — убрать валюту из набора (свои данные не трогаем). */
  const removeCcy = (x: string) => {
    const next = customCcys.filter((c) => c !== x);
    setCustomCcys(next);
    saveCustomCcys(next);
    if (sel === x) setCcy(null); // вернётся к валюте дохода
  };

  const r = rep.data;
  const c = r?.currency ?? 'USD';
  const parts = r
    ? ([
        { key: 'living', label: 'Повседневные', v: r.spent.living },
        { key: 'commitments', label: 'Регулярные платежи', v: r.spent.commitments },
        { key: 'credits', label: 'Кредиты', v: r.spent.credits },
        { key: 'loans', label: 'Долги людям', v: r.spent.loans_repaid },
      ] as const)
    : [];
  const delta = r && r.prev.spent_total > 0 ? Math.round((r.spent.total / r.prev.spent_total - 1) * 100) : null;
  const maxB = r ? Math.max(1, ...r.buckets.map((b) => b.living + b.other)) : 1;
  const maxRecv = r ? Math.max(1, ...r.buckets.map((b) => b.received)) : 1;
  const avgB = r ? r.buckets.reduce((s, b) => s + b.living + b.other, 0) / Math.max(1, r.buckets.length) : 0;
  const selBucket = r?.buckets.find((b) => b.key === selB) ?? null;

  return (
    <>
      <h1 class={h1Cls}>
        <ChartColumn size={20} strokeWidth={1.5} class="text-sky-400" /> Отчёты
      </h1>
      <div class="mb-3 flex gap-1 rounded-xl border border-white/10 bg-zinc-900 p-1">
        {PERIODS.map((x) => (
          <button
            type="button"
            class={
              period === x.p
                ? 'flex-1 rounded-lg bg-sky-600 py-2 text-[13px] font-medium text-white transition'
                : 'flex-1 rounded-lg py-2 text-[13px] text-zinc-400 transition hover:text-zinc-200'
            }
            onClick={() => {
              setPeriod(x.p);
              setOffset(0);
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div class="mb-3 flex flex-wrap items-center justify-center gap-2">
        {chipCcys.map((x) =>
          customCcys.includes(x) ? (
            <span
              key={x}
              role="button"
              tabIndex={0}
              class={`${x === sel ? chipOnCls : chipCls} inline-flex cursor-pointer items-center gap-0.5`}
              onClick={() => setCcy(x)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setCcy(x);
                }
              }}
            >
              {x}
              <span
                role="button"
                tabIndex={0}
                aria-label={`Убрать ${x} из чипов`}
                class="-mr-1 rounded-full p-0.5 text-zinc-500 transition hover:text-red-300"
                onClick={(e) => {
                  e.stopPropagation();
                  removeCcy(x);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    removeCcy(x);
                  }
                }}
              >
                <X size={10} strokeWidth={2} />
              </span>
            </span>
          ) : (
            <button
              key={x}
              type="button"
              class={x === sel ? chipOnCls : chipCls}
              onClick={() => setCcy(x)}
            >
              {x}
            </button>
          ),
        )}
        <button
          type="button"
          class={`${chipCls} inline-flex items-center`}
          aria-label="Другая валюта"
          title="Добавить валюту в чипы"
          onClick={() => setPickerOpen((o) => !o)}
        >
          <Plus size={13} strokeWidth={1.5} />
        </button>
      </div>
      {pickerOpen && (
        <div class="mb-3 flex items-start justify-center gap-2">
          <div class="w-44">
            <CcySelect
              value={pickVal}
              onChange={setPickVal}
              extra={chipCcys}
              placeholder="Другая валюта…"
            />
          </div>
          <button
            type="button"
            class={`${chipOnCls} disabled:opacity-40`}
            disabled={!/^[A-Z]{3,5}$/.test(pickVal.trim().toUpperCase())}
            onClick={() => addCcy(pickVal)}
          >
            Добавить
          </button>
        </div>
      )}
      <div class="mb-4 flex items-center justify-center gap-3">
        <button
          type="button"
          class="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          onClick={() => setOffset((o) => Math.max(-60, o - 1))}
        >
          <ChevronLeft size={18} strokeWidth={1.5} />
        </button>
        <b class="min-w-24 text-center text-[15px]">{r?.label ?? '…'}</b>
        <button
          type="button"
          class="rounded-lg p-2 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-30"
          disabled={offset >= 0}
          onClick={() => setOffset((o) => Math.min(0, o + 1))}
        >
          <ChevronRight size={18} strokeWidth={1.5} />
        </button>
      </div>

      {(rep.loading || sel === null) && <Loading />}
      {!rep.loading && sel !== null && (rep.error || !r) ? (
        (() => {
          const v = errorView(rep.error);
          return <ErrorView title={v.title} text={v.text} onRetry={rep.reload} />;
        })()
      ) : null}
      {!rep.loading && r && (
        <>
          <div class="grid grid-cols-3 gap-2.5">
            <div class="min-w-0 rounded-2xl border border-white/10 bg-zinc-900/80 p-3 text-center shadow-lg shadow-black/30">
              <div class="whitespace-nowrap text-[clamp(11px,3.6vw,15px)] font-semibold tabular-nums text-emerald-400">
                {fmtMinorAuto(r.received.total, c)}
              </div>
              <div class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">Получено</div>
            </div>
            <div class="min-w-0 rounded-2xl border border-white/10 bg-zinc-900/80 p-3 text-center shadow-lg shadow-black/30">
              <div class="whitespace-nowrap text-[clamp(11px,3.6vw,15px)] font-semibold tabular-nums">
                {fmtMinorAuto(r.spent.total, c)}
              </div>
              <div class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">Потрачено</div>
            </div>
            <div class="min-w-0 rounded-2xl border border-white/10 bg-zinc-900/80 p-3 text-center shadow-lg shadow-black/30">
              <div
                class={`whitespace-nowrap text-[clamp(11px,3.6vw,15px)] font-semibold tabular-nums ${r.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {r.net >= 0 ? '+' : '−'}
                {fmtMinorAuto(Math.abs(r.net), c)}
              </div>
              <div class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">Итог</div>
            </div>
          </div>
          {delta !== null && (
            <p class={`${mutedCls} mt-3 flex items-center gap-1`}>
              {delta >= 0 ? (
                <TrendingUp size={13} strokeWidth={1.5} class="text-red-400" />
              ) : (
                <TrendingDown size={13} strokeWidth={1.5} class="text-emerald-400" />
              )}
              {Math.abs(delta)}% расходов к {r.prev.label}
            </p>
          )}

          <h2 class={`${headCls} mt-6`}>
            <ChartPie size={16} strokeWidth={1.5} /> Распределение расходов
          </h2>
          <div class={`${cardCls} mt-2`}>
            <div class="mb-3 mt-1 flex h-3.5 overflow-hidden rounded-full">
              {parts.map(
                (p) =>
                  p.v > 0 && (
                    <i key={p.key} style={{ width: `${(p.v / r.spent.total) * 100}%`, background: COLORS[p.key] }} />
                  ),
              )}
            </div>
            {parts.map((p) => (
              <div class={`${rowCls} mt-1.5`} key={p.key}>
                <span class="flex items-center">
                  <i class="mr-1.5 inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: COLORS[p.key] }} />
                  {p.label}
                </span>
                <span>
                  {fmtMinorAuto(p.v, c)} · {r.spent.total > 0 ? Math.round((p.v / r.spent.total) * 100) : 0}%
                </span>
              </div>
            ))}
            <div class={`${rowCls} mt-2`}>
              <span class={mutedCls}>Бюджет</span>
              <span class={mutedCls}>
                {Math.round(r.living_limit.used_pct * 100)}% (из {fmtMinorAuto(r.living_limit.cap, c)})
              </span>
            </div>
            <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
              <i
                class={`block h-full rounded-full ${r.living_limit.used_pct > 1 ? 'bg-red-400' : 'bg-sky-500'}`}
                style={{ width: `${Math.min(100, Math.round(r.living_limit.used_pct * 100))}%` }}
              />
            </div>
          </div>

          {r.categories.length > 0 && (
            <>
              <h2 class={`${headCls} mt-6`}>
                <Tags size={16} strokeWidth={1.5} /> По категориям
              </h2>
              <div class={`${cardCls} mt-2`}>
                {[...r.categories].sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : b.amount - a.amount)).map((x) => (
                  <div key={x.id ?? -1} class="mt-3 first:mt-0">
                    <div class={rowCls}>
                      <span>
                        {x.emoji} {x.name}
                        <span class="ml-1 text-[11px] text-zinc-500">· {x.count}</span>
                      </span>
                      <span>
                        {fmtMinorAuto(x.amount, c)} · {Math.round(x.share * 100)}%
                      </span>
                    </div>
                    <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
                      <i class="block h-full rounded-full bg-sky-500" style={{ width: `${Math.round(x.share * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2 class={`${headCls} mt-6`}>
            <ChartColumn size={16} strokeWidth={1.5} /> Динамика
          </h2>
          <div class={`${cardCls} mt-2`}>
            <div class="relative">
              <div class="scrollbar-thin flex min-h-[110px] items-end gap-1 overflow-x-auto px-2 pb-1 pt-2">
                {r.buckets.map((b) => (
                  <button
                    type="button"
                    class="flex min-w-[18px] flex-1 basis-[18px] flex-col items-center rounded-md pt-0.5 transition"
                    key={b.key}
                    onClick={() => setSelB((k) => (k === b.key ? null : b.key))}
                  >
                    <div class="relative flex h-[88px] items-end">
                      <div
                        class={`flex w-3 flex-col-reverse rounded-t-sm ${selB === b.key && b.living + b.other > 0 ? 'ring-1 ring-sky-300/70' : ''}`}
                      >
                        <i class="block w-full" style={{ height: `${((b.living / maxB) * 88) | 0}px`, background: COLORS.living }} />
                        <i class="block w-full" style={{ height: `${((b.other / maxB) * 88) | 0}px`, background: COLORS.commitments }} />
                      </div>
                      {/* поступление — тонкая полоска справа от стека, абсолютная:
                          не сдвигает центровку столбца над подписью */}
                      {b.received > 0 && (
                        <div class="absolute bottom-0 left-full ml-0.5 w-[3px] rounded-sm bg-emerald-500" style={{ height: `${((b.received / maxRecv) * 88) | 0}px` }} />
                      )}
                    </div>
                    <div class={`mt-1 text-[9px] ${selB === b.key ? 'font-medium text-sky-300' : 'text-zinc-500'}`}>
                      {b.label}
                    </div>
                  </button>
                ))}
              </div>
              {/* пунктир — средний расход за бакет */}
              {avgB > 0 && (
                <i
                  class="pointer-events-none absolute inset-x-0 border-t border-dashed border-zinc-500/70"
                  style={{ bottom: `${18 + Math.round((avgB / maxB) * 88)}px` }}
                />
              )}
            </div>
            <div class="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
              <span class="inline-flex items-center gap-1">
                <i class="h-2 w-2 rounded-[3px]" style={{ background: COLORS.living }} /> Повседневные
              </span>
              <span class="inline-flex items-center gap-1">
                <i class="h-2 w-2 rounded-[3px]" style={{ background: COLORS.commitments }} /> Прочие
                расходы
              </span>
              <span class="inline-flex items-center gap-1">
                <i class="h-2 w-2 rounded-[3px] bg-emerald-500" /> Поступило
              </span>
              {avgB > 0 && (
                <span class="inline-flex items-center gap-1">
                  <i class="w-4 border-t border-dashed border-zinc-500" /> среднее
                </span>
              )}
            </div>
            {selBucket && (
              <p class="mt-2 rounded-lg bg-white/5 px-3 py-2 text-center text-[12px] text-zinc-300">
                <b>{selBucket.key.length > 7 ? fmtDay(selBucket.key) : selBucket.label}</b>
                {' · '}
                {fmtMinorAuto(selBucket.living + selBucket.other, c)} потрачено
                {' · '}
                {fmtMinorAuto(selBucket.received, c)} поступило
              </p>
            )}
          </div>

          {r.top_expenses.length > 0 && (
            <>
              <h2 class={`${headCls} mt-6`}>
                <Receipt size={16} strokeWidth={1.5} /> Крупные траты
                <Info title="Крупные траты">
                  Крупная — статистический выброс внутри своей категории за период:
                  заметно выше типичного разброса (правило Тьюки) и ≥2% всех повседневных
                  трат. 10 000 ₽ в кафе — крупно, на ремонт авто — обычное дело; случайная
                  трата в 1 ₽ статистику не ломает. Бейдж «×2,4» — во сколько раз больше
                  медианы категории. Три самые большие траты показаны в любом случае.
                </Info>
              </h2>
              <div class={`${listCardCls} mt-2`}>
                <ul class="divide-y divide-white/5">
                  {r.top_expenses.map((e) => (
                    <li
                      class={`${liCls} cursor-pointer transition hover:bg-white/5`}
                      onClick={() => nav.push({ id: 'expense', expenseId: e.id })}
                    >
                      <div class={rowCls}>
                        <span class="min-w-0 truncate">
                          {fmtDay(e.spent_on)}
                          {e.note ? ` · ${e.note}` : ''}
                        </span>
                        <span class="ml-2 flex-none whitespace-nowrap tabular-nums">
                          {e.ratio !== null && (
                            <span class="mr-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 align-middle text-[10px] font-medium text-amber-300">
                              {e.ratio > 99 ? '×99+' : `×${String(e.ratio).replace('.', ',')}`}
                            </span>
                          )}
                          {fmtMinorAuto(e.amount, c)}
                        </span>
                      </div>
                      <div class="mt-0.5 text-[11px] text-zinc-500">
                        {e.cat_emoji} {e.cat_name}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          <p class={`${mutedCls} mt-3`}>
            Суммы пересчитаны по текущему курсу ({r.fx_as_of || '—'})
            <Info title="Пересчёт валют">
              <p>
                Все суммы приводятся к выбранной валюте по курсу на сегодня — а
                не по курсу дня записи.
              </p>
              <p>
                Для точной сверки в исходной валюте выберите её в чипах валют
                выше.
              </p>
            </Info>
          </p>
        </>
      )}
    </>
  );
}
