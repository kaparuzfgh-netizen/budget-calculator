/**
 * home.tsx — «Обзор»: хедер с приветствием и аватаром-профилем,
 * быстрые действия, «К оплате в месяце» с кнопками оплаты,
 * повседневные с прогресс-барами, доход и сетка разделов.
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { Overview, Upcoming, UpcomingItem, WeekStatus } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinor, fmtPct } from '../fmt';
import { ErrorView, errorView, Loading, useData } from '../ui';

const INCOME_SOURCE: Record<Overview['income_month_source'], string> = {
  actual: 'факт по записям',
  typical: 'базовый доход',
  computed: 'расчёт (обязательства)',
  none: 'не указан',
};
const MONTHS = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
];

function Bar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div class="bar">
      <i class={pct > 100 ? 'over' : ''} style={{ width: `${w}%` }} />
    </div>
  );
}

function PayRow({ api, item, onPaid }: { api: ScreenProps['api']; item: UpcomingItem; onPaid: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pay = async () => {
    setBusy(true);
    setErr(null);
    try {
      const client_id = crypto.randomUUID();
      if (item.kind === 'commitment') {
        await api.post(`/api/tma/commitments/${item.id}/payments`, { client_id });
      } else {
        await api.post(`/api/tma/debts/${item.id}/events`, {
          kind: 'payment',
          amount: item.amount_minor / 100,
          client_id,
        });
      }
      onPaid();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось оплатить');
      setBusy(false);
    }
  };
  return (
    <li class="upay">
      <div class="row">
        <span>
          {item.kind === 'commitment' ? '🧾' : '🏦'} {item.name}
          {item.overdue ? <span class="overdue"> · просрочено</span> : ''}
        </span>
        <span class="muted">до {fmtDay(item.due_on)}</span>
      </div>
      <div class="row">
        <span class={item.paid ? 'muted2' : ''}>{fmtMinor(item.amount_minor, item.currency)}</span>
        {item.paid ? (
          <span class="muted">✅ оплачено</span>
        ) : (
          <button type="button" class="btn sm" disabled={busy} onClick={() => setConfirm(true)}>
            Оплатить
          </button>
        )}
      </div>
      {confirm && !item.paid && (
        <div class="confirm">
          <p>Оплатить {fmtMinor(item.amount_minor, item.currency)}?</p>
          <div class="inline">
            <button type="button" class="btn" disabled={busy} onClick={() => void pay()}>
              Да
            </button>
            <button type="button" class="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>
              Отмена
            </button>
          </div>
          {err && <p class="err">{err}</p>}
        </div>
      )}
    </li>
  );
}

export function HomeScreen({ api, nav, onFatal, name }: ScreenProps & { name: string | null }) {
  const ov = useData(() => api.get<Overview>('/api/tma/overview'), onFatal, []);
  const wk = useData(() => api.get<WeekStatus>('/api/tma/week'), onFatal, []);
  const up = useData(() => api.get<Upcoming>('/api/tma/upcoming'), onFatal, []);

  if (ov.loading || wk.loading || up.loading) return <Loading />;
  const err = ov.error ?? wk.error ?? up.error;
  if (err || !ov.data || !wk.data || !up.data) {
    const v = errorView(err);
    return (
      <ErrorView
        title={v.title}
        text={v.text}
        onRetry={() => {
          ov.reload();
          wk.reload();
          up.reload();
        }}
      />
    );
  }

  const o = ov.data;
  const w = wk.data;
  const u = up.data;
  const c = o.living_currency;
  const weekPct = o.weekly_budget_minor > 0 ? (o.spent_week_minor / o.weekly_budget_minor) * 100 : 0;
  const monthPct = o.month_cap_minor > 0 ? (o.spent_month_minor / o.month_cap_minor) * 100 : 0;
  const paidN = u.items.filter((x) => x.paid).length;
  const monthWord = MONTHS[Number(u.month.slice(5, 7)) - 1]!;

  return (
    <>
      <div class="hrow">
        <h1>Обзор{name ? ` · ${name}` : ''}</h1>
        <button type="button" class="avatar" onClick={() => nav.push({ id: 'profile' })} title="Профиль">
          {name?.trim().charAt(0).toUpperCase() ?? '👤'}
        </button>
      </div>

      <div class="quick">
        <button type="button" class="btn" onClick={() => nav.push({ id: 'spent-add' })}>
          ➕ Трата
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'income' })}>
          💵 Доход
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'report' })}>
          📈 Отчёты
        </button>
      </div>

      {u.items.length > 0 && (
        <>
          <h2>К оплате в {monthWord}</h2>
          <div class="card">
            <p class="muted">Регулярные платежи и кредиты этого месяца</p>
            <ul class="plain">
              {u.items.map((x) => (
                <PayRow key={`${x.kind}:${x.id}`} api={api} item={x} onPaid={() => { nav.flash(`Оплачено: ${x.name}`); up.reload(); ov.reload(); }} />
              ))}
            </ul>
            <p class="muted">Оплачено {paidN} из {u.items.length}</p>
          </div>
        </>
      )}

      <h2>Бюджет</h2>
      <div class="card">
        <p class="muted">повседневных израсходовано</p>
        <div class="row">
          <span>Неделя</span>
          <span>
            <b>{fmtMinor(o.spent_week_minor, c)}</b> из {fmtMinor(o.weekly_budget_minor, c)}
          </span>
        </div>
        <Bar pct={weekPct} />
        <div class="row">
          <span class="muted">Остаток недели</span>
          <span class={o.week_remaining_minor < 0 ? 'err' : ''}>{fmtMinor(o.week_remaining_minor, c)}</span>
        </div>
        <div class="row">
          <span>Месяц</span>
          <span>
            <b>{fmtMinor(o.spent_month_minor, c)}</b> из {fmtMinor(o.month_cap_minor, c)}
          </span>
        </div>
        <Bar pct={monthPct} />
        <div class="row">
          <span class="muted">Burn rate</span>
          <span class={w.burn_rate > 1 ? 'warn' : ''}>
            {fmtPct(w.burn_rate)}
            {w.burn_rate > 1 ? ' — тратим быстрее плана' : ''}
          </span>
        </div>
      </div>

      <h2>Доход за месяц</h2>
      <div class="card">
        <div class="big">{fmtMinor(o.income_month_minor, o.income_month_currency)}</div>
        <div class="muted">
          {INCOME_SOURCE[o.income_month_source]}
          {o.income_entries_count ? ` · записей: ${o.income_entries_count}` : ''}
        </div>
      </div>

      {o.fx_note ? <p class="warn">{o.fx_note}</p> : <p class="muted">Курсы на {o.fx_as_of || '—'}</p>}

      <div class="menu">
        <button type="button" class="btn" onClick={() => nav.push({ id: 'plan' })}>
          📊 План
        </button>
        <button type="button" class="btn" onClick={() => nav.push({ id: 'week' })}>
          📅 Неделя
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
        <button type="button" class="btn" onClick={() => nav.push({ id: 'categories' })}>
          🏷 Категории
        </button>
      </div>
    </>
  );
}
