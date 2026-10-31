/**
 * home.tsx — «Обзор»: хедер с приветствием и аватаром-профилем,
 * быстрые действия, «К оплате в месяце» с кнопками оплаты,
 * повседневные с прогресс-барами, доход и сетка разделов.
 */
import { useState } from 'preact/hooks';
import {
  ArrowLeftRight,
  Banknote,
  CalendarDays,
  ChartColumn,
  ChartPie,
  CircleCheck,
  Handshake,
  Landmark,
  Plus,
  Receipt,
  Tags,
  User,
  Wallet,
} from 'lucide-preact';
import { ApiError } from '../api';
import type { Overview, Upcoming, UpcomingItem, WeekStatus } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinor, fmtPct } from '../fmt';
import {
  cardCls,
  confirmNeutralCls,
  ErrorView,
  errorView,
  headCls,
  Info,
  listCardCls,
  Loading,
  mutedCls,
  rowCls,
  smBtnCls,
  smGhostBtnCls,
  smPrimaryBtnCls,
  useData,
} from '../ui';

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
    <div class="mb-2 mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
      <i class={`block h-full rounded-full ${pct > 100 ? 'bg-red-400' : 'bg-sky-500'}`} style={{ width: `${w}%` }} />
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
    <li class="px-4 py-3">
      <div class={rowCls}>
        <span class="flex items-center gap-1.5 text-[15px] text-zinc-100">
          {item.kind === 'commitment' ? (
            <Receipt size={15} strokeWidth={1.5} class="text-zinc-500" />
          ) : (
            <Landmark size={15} strokeWidth={1.5} class="text-zinc-500" />
          )}
          {item.name}
          {item.overdue ? <span class="text-[13px] text-red-400"> · просрочено</span> : ''}
        </span>
        <span class="text-[13px] text-zinc-500">до {fmtDay(item.due_on)}</span>
      </div>
      <div class={`${rowCls} mt-1`}>
        <span class={item.paid ? 'text-zinc-500 line-through' : 'text-zinc-100'}>
          {fmtMinor(item.amount_minor, item.currency)}
        </span>
        {item.paid ? (
          <span class="flex items-center gap-1 text-xs font-medium text-emerald-400">
            <CircleCheck size={14} strokeWidth={1.5} /> оплачено
          </span>
        ) : (
          <button type="button" class={smBtnCls} disabled={busy} onClick={() => setConfirm(true)}>
            Оплатить
          </button>
        )}
      </div>
      {confirm && !item.paid && (
        <div class={confirmNeutralCls}>
          <p class="text-sm">Оплатить {fmtMinor(item.amount_minor, item.currency)}?</p>
          <div class="mt-2 flex gap-2">
            <button type="button" class={smPrimaryBtnCls} disabled={busy} onClick={() => void pay()}>
              Да
            </button>
            <button type="button" class={smGhostBtnCls} disabled={busy} onClick={() => setConfirm(false)}>
              Отмена
            </button>
          </div>
          {err && <p class="mt-2 text-sm text-red-400">{err}</p>}
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

  const quickCls =
    'flex flex-col items-center gap-1.5 rounded-2xl border border-white/10 bg-zinc-900/80 py-3.5 text-[13px] text-zinc-100 shadow-lg shadow-black/30 transition hover:bg-zinc-800/80';
  const tileCls =
    'flex items-center gap-2.5 rounded-2xl border border-white/10 bg-zinc-900/80 px-4 py-3.5 text-[15px] text-zinc-100 shadow-lg shadow-black/30 transition hover:bg-zinc-800/80';
  const iconCls = 'text-sky-400';

  return (
    <>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="text-xl font-semibold tracking-tight">Обзор{name ? ` · ${name}` : ''}</h1>
        <button
          type="button"
          class="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-zinc-800 text-base font-semibold text-zinc-100 transition hover:bg-zinc-700"
          onClick={() => nav.push({ id: 'profile' })}
          title="Профиль"
        >
          {name?.trim().charAt(0).toUpperCase() ?? <User size={20} strokeWidth={1.5} />}
        </button>
      </div>

      <div class="mb-6 grid grid-cols-3 gap-2.5">
        <button type="button" class={quickCls} onClick={() => nav.push({ id: 'spent-add' })}>
          <Plus size={18} strokeWidth={1.5} class={iconCls} /> Трата
        </button>
        <button type="button" class={quickCls} onClick={() => nav.push({ id: 'income' })}>
          <Banknote size={18} strokeWidth={1.5} class={iconCls} /> Доход
        </button>
        <button type="button" class={quickCls} onClick={() => nav.push({ id: 'report' })}>
          <ChartColumn size={18} strokeWidth={1.5} class={iconCls} /> Отчёты
        </button>
      </div>

      {u.items.length > 0 && (
        <>
          <h2 class={headCls}>
            <CalendarDays size={16} strokeWidth={1.5} /> К оплате в {monthWord}
            <Info title="К оплате">
              <p>
                Регулярные платежи и кредиты этого месяца. «Оплатить»
                записывает оплату в журнал — сумму можно поправить.
              </p>
              <p>
                Если у платежа задан день, в день срока бот отметит оплату сам,
                а за 2 дня до срока — напомнит.
              </p>
            </Info>
          </h2>
          <div class={`${listCardCls} mt-2`}>
            <ul class="divide-y divide-white/5">
              {u.items.map((x) => (
                <PayRow key={`${x.kind}:${x.id}`} api={api} item={x} onPaid={() => { nav.flash(`Оплачено: ${x.name}`); up.reload(); ov.reload(); }} />
              ))}
            </ul>
            <p class="border-t border-white/5 px-4 py-2.5 text-[13px] text-zinc-500">
              Оплачено {paidN} из {u.items.length}
            </p>
          </div>
        </>
      )}

      <h2 class={`${headCls} mt-6`}>
        <Wallet size={16} strokeWidth={1.5} /> Бюджет
      </h2>
      <div class={`${cardCls} mt-2`}>
        <p class={mutedCls}>повседневных израсходовано</p>
        <div class={`${rowCls} mt-2`}>
          <span>Неделя</span>
          <span>
            <b>{fmtMinor(o.spent_week_minor, c)}</b> из {fmtMinor(o.weekly_budget_minor, c)}
          </span>
        </div>
        <Bar pct={weekPct} />
        <div class={rowCls}>
          <span class={mutedCls}>Остаток недели</span>
          <span class={o.week_remaining_minor < 0 ? 'text-red-400' : ''}>{fmtMinor(o.week_remaining_minor, c)}</span>
        </div>
        <div class={`${rowCls} mt-2`}>
          <span>Месяц</span>
          <span>
            <b>{fmtMinor(o.spent_month_minor, c)}</b> из {fmtMinor(o.month_cap_minor, c)}
          </span>
        </div>
        <Bar pct={monthPct} />
        <div class={rowCls}>
          <span class={mutedCls}>
            Burn rate
            <Info title="Burn rate">
              <p>
                Темп расхода бюджета: 100% — тратите ровно по плану к концу
                недели; выше — быстрее, и бюджет кончится раньше.
              </p>
            </Info>
          </span>
          <span class={w.burn_rate > 1 ? 'text-amber-400' : ''}>
            {fmtPct(w.burn_rate)}
            {w.burn_rate > 1 ? ' — тратим быстрее плана' : ''}
          </span>
        </div>
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Banknote size={16} strokeWidth={1.5} /> Доход за месяц
        <Info title="Откуда берётся доход">
          <p>
            Сначала — сумма ваших записей дохода за месяц. Если записей нет —
            базовый доход из профиля. Если и он пуст — расчёт из ваших
            обязательств (платежи + бюджет + кредиты).
          </p>
        </Info>
      </h2>
      <div class={`${cardCls} mt-2`}>
        <div class="text-2xl font-semibold">{fmtMinor(o.income_month_minor, o.income_month_currency)}</div>
        <div class={`${mutedCls} mt-0.5`}>
          {INCOME_SOURCE[o.income_month_source]}
          {o.income_entries_count ? ` · записей: ${o.income_entries_count}` : ''}
        </div>
      </div>

      {o.fx_note ? (
        <p class="mt-3 text-[13px] text-amber-400">{o.fx_note}</p>
      ) : (
        <p class="mt-3 text-[13px] text-zinc-500">Курсы на {o.fx_as_of || '—'}</p>
      )}

      <div class="mt-5 grid grid-cols-2 gap-2.5">
        <button type="button" class={tileCls} onClick={() => nav.push({ id: 'plan' })}>
          <ChartPie size={18} strokeWidth={1.5} class={iconCls} /> План
        </button>
        <button type="button" class={tileCls} onClick={() => nav.push({ id: 'week' })}>
          <CalendarDays size={18} strokeWidth={1.5} class={iconCls} /> Неделя
        </button>
        <button type="button" class={tileCls} onClick={() => nav.push({ id: 'debts' })}>
          <Landmark size={18} strokeWidth={1.5} class={iconCls} /> Кредиты
        </button>
        <button type="button" class={tileCls} onClick={() => nav.push({ id: 'loans' })}>
          <Handshake size={18} strokeWidth={1.5} class={iconCls} /> Долги
        </button>
        <button type="button" class={tileCls} onClick={() => nav.push({ id: 'fx' })}>
          <ArrowLeftRight size={18} strokeWidth={1.5} class={iconCls} /> Курсы
        </button>
        <button type="button" class={tileCls} onClick={() => nav.push({ id: 'categories' })}>
          <Tags size={18} strokeWidth={1.5} class={iconCls} /> Категории
        </button>
      </div>
    </>
  );
}
