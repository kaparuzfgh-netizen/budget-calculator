/**
 * report.tsx — экран «📈 Отчёты»: период/сдвиг, сводные плитки,
 * «куда ушли деньги» (стек-бар + норма), категории, динамика, топ трат.
 * Данные: GET /api/tma/report?period&offset&ccy (minor units, валюта — чипы).
 */
import { useState } from 'preact/hooks';
import type { DebtsList, Profile, Report, ReportPeriod } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinor } from '../fmt';
import { ErrorView, errorView, Info, Loading, useData } from '../ui';

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
      <h1>📈 Отчёты</h1>
      <div class="seg">
        {PERIODS.map((x) => (
          <button
            type="button"
            class={`btn${period === x.p ? ' on' : ''}`}
            onClick={() => {
              setPeriod(x.p);
              setOffset(0);
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div class="chips">
        {chipCcys.map((x) => (
          <button
            type="button"
            class={`chip${x === sel ? ' on' : ''}`}
            onClick={() => setCcy(x)}
          >
            {x}
          </button>
        ))}
      </div>
      <div class="row">
        <button type="button" class="navbtn" onClick={() => setOffset((o) => Math.max(-60, o - 1))}>
          ‹
        </button>
        <b>{r?.label ?? '…'}</b>
        <button type="button" class="navbtn" disabled={offset >= 0} onClick={() => setOffset((o) => Math.min(0, o + 1))}>
          ›
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
          <div class="tiles">
            <div class="tile">
              <div class="v good">{fmtMinor(r.received.total, c)}</div>
              <div class="l">Получено</div>
            </div>
            <div class="tile">
              <div class="v">{fmtMinor(r.spent.total, c)}</div>
              <div class="l">Потрачено</div>
            </div>
            <div class="tile">
              <div class={`v ${r.net >= 0 ? 'good' : 'err'}`}>
                {r.net >= 0 ? '+' : '−'}
                {fmtMinor(Math.abs(r.net), c)}
              </div>
              <div class="l">Итог</div>
            </div>
          </div>
          {delta !== null && (
            <p class="muted">
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% расходов к {r.prev.label}
            </p>
          )}

          <h2>Куда ушли деньги</h2>
          <div class="card">
            <div class="stack">
              {parts.map(
                (p) =>
                  p.v > 0 && (
                    <i key={p.key} style={{ width: `${(p.v / r.spent.total) * 100}%`, background: COLORS[p.key] }} />
                  ),
              )}
            </div>
            {parts.map((p) => (
              <div class="row" key={p.key}>
                <span>
                  <i class="dot" style={{ background: COLORS[p.key] }} />
                  {p.label}
                </span>
                <span>
                  {fmtMinor(p.v, c)} · {r.spent.total > 0 ? Math.round((p.v / r.spent.total) * 100) : 0}%
                </span>
              </div>
            ))}
            <div class="row">
              <span class="muted">Бюджет</span>
              <span class="muted">
                {Math.round(r.living_limit.used_pct * 100)}% (из {fmtMinor(r.living_limit.cap, c)})
              </span>
            </div>
            <div class="bar">
              <i
                class={r.living_limit.used_pct > 1 ? 'over' : ''}
                style={{ width: `${Math.min(100, Math.round(r.living_limit.used_pct * 100))}%` }}
              />
            </div>
          </div>

          {r.categories.length > 0 && (
            <>
              <h2>По категориям</h2>
              <div class="card">
                {[...r.categories].sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : b.amount - a.amount)).map((x) => (
                  <div key={x.id ?? -1}>
                    <div class="row">
                      <span>
                        {x.emoji} {x.name}
                      </span>
                      <span>
                        {fmtMinor(x.amount, c)} · {Math.round(x.share * 100)}%
                      </span>
                    </div>
                    <div class="bar">
                      <i style={{ width: `${Math.round(x.share * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2>Динамика</h2>
          <div class="card">
            <div class="chart">
              {r.buckets.map((b) => (
                <div class="col" key={b.key}>
                  <div class="colbar">
                    <div class="cb">
                      <i style={{ height: `${((b.living / maxB) * 88) | 0}px`, background: COLORS.living }} />
                      <i style={{ height: `${((b.other / maxB) * 88) | 0}px`, background: COLORS.commitments }} />
                    </div>
                    <div class="cv" style={{ height: `${((b.received / maxRecv) * 88) | 0}px` }} />
                  </div>
                  <div class="cl">{b.label}</div>
                </div>
              ))}
            </div>
          </div>

          {r.top_expenses.length > 0 && (
            <>
              <h2>Крупные траты</h2>
              <div class="card">
                <ul class="plain">
                  {r.top_expenses.map((e) => (
                    <li class="clickable" onClick={() => nav.push({ id: 'expense', expenseId: e.id })}>
                      <div class="row">
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
          <p class="muted">
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
