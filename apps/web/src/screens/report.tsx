/**
 * report.tsx — экран «Отчёты»: период/сдвиг, сводные плитки,
 * «куда ушли деньги» (стек-бар + норма), категории, динамика, топ трат.
 * Данные: GET /api/tma/report?period&offset&ccy (minor units, валюта — чипы).
 */
import { useState } from 'preact/hooks';
import {
  ChartColumn,
  ChartPie,
  ChevronLeft,
  ChevronRight,
  Receipt,
  Tags,
  TrendingDown,
  TrendingUp,
} from 'lucide-preact';
import type { DebtsList, Profile, Report, ReportPeriod } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinor } from '../fmt';
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
/** Базовый набор чипов; профиль/кредиты добавляют свои, всего ≤ 7. */
const CHIP_BASE = ['USD', 'EUR', 'RUB', 'KGS', 'KZT'];

const chipCls =
  'rounded-full border border-white/10 bg-zinc-900 px-3.5 py-2 text-[13px] text-zinc-300 transition hover:border-white/20';
const chipOnCls =
  'rounded-full border border-sky-500/60 bg-sky-500/15 px-3.5 py-2 text-[13px] text-sky-300';

export function ReportScreen({ api, nav, onFatal }: ScreenProps) {
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [offset, setOffset] = useState(0);
  // null → валюта дохода из профиля (дефолт отчёта)
  const [ccy, setCcy] = useState<string | null>(null);
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
  const chipCcys = [
    ...new Set(
      [
        ...CHIP_BASE,
        prof.data?.income_currency,
        prof.data?.living_currency,
        prof.data?.base_currency,
        prof.data?.expense_currency,
        ...(debts.data?.debts.map((d) => d.currency) ?? []),
      ].filter((x): x is string => !!x),
    ),
  ].slice(0, 7);

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
      <div class="mb-3 flex flex-wrap items-center gap-2">
        {chipCcys.map((x) => (
          <button
            type="button"
            class={x === sel ? chipOnCls : chipCls}
            onClick={() => setCcy(x)}
          >
            {x}
          </button>
        ))}
        {/* Остальные валюты — общий список + «Другое…» */}
        <div class="w-24">
          <CcySelect value={sel ?? ''} onChange={(v) => setCcy(v)} extra={chipCcys} />
        </div>
      </div>
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
            <div class="rounded-2xl border border-white/10 bg-zinc-900/80 p-3 text-center shadow-lg shadow-black/30">
              <div class="text-base font-semibold text-emerald-400">{fmtMinor(r.received.total, c)}</div>
              <div class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">Получено</div>
            </div>
            <div class="rounded-2xl border border-white/10 bg-zinc-900/80 p-3 text-center shadow-lg shadow-black/30">
              <div class="text-base font-semibold">{fmtMinor(r.spent.total, c)}</div>
              <div class="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-400">Потрачено</div>
            </div>
            <div class="rounded-2xl border border-white/10 bg-zinc-900/80 p-3 text-center shadow-lg shadow-black/30">
              <div class={`text-base font-semibold ${r.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {r.net >= 0 ? '+' : '−'}
                {fmtMinor(Math.abs(r.net), c)}
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
            <ChartPie size={16} strokeWidth={1.5} /> Куда ушли деньги
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
                  {fmtMinor(p.v, c)} · {r.spent.total > 0 ? Math.round((p.v / r.spent.total) * 100) : 0}%
                </span>
              </div>
            ))}
            <div class={`${rowCls} mt-2`}>
              <span class={mutedCls}>Бюджет</span>
              <span class={mutedCls}>
                {Math.round(r.living_limit.used_pct * 100)}% (из {fmtMinor(r.living_limit.cap, c)})
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
                      </span>
                      <span>
                        {fmtMinor(x.amount, c)} · {Math.round(x.share * 100)}%
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
            <div class="scrollbar-thin flex min-h-[110px] items-end gap-1 overflow-x-auto px-1 pb-1 pt-2">
              {r.buckets.map((b) => (
                <div class="flex min-w-[18px] flex-1 basis-[18px] flex-col items-center" key={b.key}>
                  <div class="flex h-[88px] items-end gap-0.5">
                    <div class="flex w-3 flex-col-reverse rounded-t-sm">
                      <i class="block w-full" style={{ height: `${((b.living / maxB) * 88) | 0}px`, background: COLORS.living }} />
                      <i class="block w-full" style={{ height: `${((b.other / maxB) * 88) | 0}px`, background: COLORS.commitments }} />
                    </div>
                    <div class="w-[3px] self-end rounded-sm bg-emerald-500" style={{ height: `${((b.received / maxRecv) * 88) | 0}px` }} />
                  </div>
                  <div class="mt-1 text-[9px] text-zinc-500">{b.label}</div>
                </div>
              ))}
            </div>
          </div>

          {r.top_expenses.length > 0 && (
            <>
              <h2 class={`${headCls} mt-6`}>
                <Receipt size={16} strokeWidth={1.5} /> Крупные траты
              </h2>
              <div class={`${listCardCls} mt-2`}>
                <ul class="divide-y divide-white/5">
                  {r.top_expenses.map((e) => (
                    <li
                      class={`${liCls} cursor-pointer transition hover:bg-white/5`}
                      onClick={() => nav.push({ id: 'expense', expenseId: e.id })}
                    >
                      <div class={rowCls}>
                        <span>
                          {fmtDay(e.spent_on)}
                          {e.note ? ` · ${e.note}` : ''}
                        </span>
                        <span>{fmtMinor(e.amount, c)}</span>
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
