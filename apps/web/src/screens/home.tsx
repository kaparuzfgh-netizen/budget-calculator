/**
 * home.tsx — «Обзор»: доход месяца (с источником), обязательные платежи,
 * неделя (потрачено/остаток), месяц (потрачено/лимит) и burn rate.
 * Данные: GET /api/tma/overview + GET /api/tma/week (burn rate и дневной
 * остаток живут только там). Кнопки-разделы ведут в стек экранов.
 */
import type { Overview, WeekStatus } from '../api';
import type { ScreenProps } from '../app';
import { fmtMinor, fmtPct } from '../fmt';
import { ErrorView, errorView, Loading, useData } from '../ui';

const INCOME_SOURCE: Record<Overview['income_month_source'], string> = {
  actual: 'факт по записям',
  typical: 'типичный доход',
  none: 'не указан',
};

export function HomeScreen({ api, nav, onFatal, name }: ScreenProps & { name: string | null }) {
  const ov = useData(() => api.get<Overview>('/api/tma/overview'), onFatal, []);
  const wk = useData(() => api.get<WeekStatus>('/api/tma/week'), onFatal, []);

  if (ov.loading || wk.loading) return <Loading />;
  const err = ov.error ?? wk.error;
  if (err || !ov.data || !wk.data) {
    const v = errorView(err);
    return (
      <ErrorView
        title={v.title}
        text={v.text}
        onRetry={() => {
          ov.reload();
          wk.reload();
        }}
      />
    );
  }

  const o = ov.data;
  const w = wk.data;
  const c = o.living_currency;
  const weekPct =
    o.weekly_budget_minor > 0
      ? Math.min(999, Math.round((o.spent_week_minor / o.weekly_budget_minor) * 100))
      : 0;
  const monthPct =
    o.month_cap_minor > 0
      ? Math.min(999, Math.round((o.spent_month_minor / o.month_cap_minor) * 100))
      : 0;

  return (
    <>
      <h1>Обзор{name ? ` · ${name}` : ''}</h1>

      <h2>Доход за месяц</h2>
      <div class="card">
        <div class="big">{fmtMinor(o.income_month_minor, o.income_month_currency)}</div>
        <div class="muted">
          {INCOME_SOURCE[o.income_month_source]}
          {o.income_entries_count ? ` · записей: ${o.income_entries_count}` : ''}
        </div>
      </div>

      <h2>Обязательные платежи</h2>
      <div class="card">
        {o.commitments.length ? (
          <ul class="plain">
            {o.commitments.map((x) => (
              <li>
                <div class="row">
                  <span>{x.name}</span>
                  <span>
                    {fmtMinor(x.amount_minor, x.currency)}
                    {x.due_day ? ` · ${x.due_day} числа` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">Нет обязательных платежей.</p>
        )}
      </div>

      <h2>Лимит жизни</h2>
      <div class="card">
        <div class="row">
          <span>Неделя</span>
          <span>
            <b>{fmtMinor(o.spent_week_minor, c)}</b> из {fmtMinor(o.weekly_budget_minor, c)} (
            {weekPct}%)
          </span>
        </div>
        <div class="row">
          <span class="muted">Остаток недели</span>
          <span class={o.week_remaining_minor < 0 ? 'err' : ''}>
            {fmtMinor(o.week_remaining_minor, c)}
          </span>
        </div>
        <div class="row">
          <span>Месяц</span>
          <span>
            <b>{fmtMinor(o.spent_month_minor, c)}</b> из {fmtMinor(o.month_cap_minor, c)} ({monthPct}
            %)
          </span>
        </div>
        <div class="row">
          <span class="muted">Burn rate</span>
          <span class={w.burn_rate > 1 ? 'warn' : ''}>
            {fmtPct(w.burn_rate)}
            {w.burn_rate > 1 ? ' — тратим быстрее плана' : ''}
          </span>
        </div>
      </div>

      {o.fx_note ? (
        <p class="warn">{o.fx_note}</p>
      ) : (
        <p class="muted">Курсы на {o.fx_as_of || '—'}</p>
      )}

      <div class="menu">
        <button type="button" class="btn" onClick={() => nav.push({ id: 'plan' })}>
          📊 План
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'week' })}>
          📅 Неделя
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'spent-add' })}>
          ➕ Трата
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'income' })}>
          💵 Доход
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'debts' })}>
          🏦 Кредиты
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'loans' })}>
          🤝 Долги
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'fx' })}>
          💱 Курсы
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'profile' })}>
          ⚙️ Профиль
        </button>
      </div>
    </>
  );
}
