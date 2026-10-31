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
  ChevronDown,
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
import { fmtDay, fmtMinor } from '../fmt';
import {
  BudgetBar,
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

/** Плавная кривая без перелётов: монотонная кубика Фрича–Карлсона. */
function smoothPath(px: number[], py: number[]): string {
  const n = px.length;
  if (n < 2) return `M${(px[0] ?? 0).toFixed(1)},${(py[0] ?? 0).toFixed(1)}`;
  const dx: number[] = [];
  const sl: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(px[i + 1]! - px[i]!);
    sl.push((py[i + 1]! - py[i]!) / dx[i]!);
  }
  const t: number[] = [sl[0]!];
  for (let i = 1; i < n - 1; i++) {
    const s0 = sl[i - 1]!;
    const s1 = sl[i]!;
    t.push(s0 * s1 <= 0 ? 0 : (s0 + s1) / 2);
  }
  t.push(sl[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / sl[i]!;
    const b = t[i + 1]! / sl[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * sl[i]!;
      t[i + 1] = k * b * sl[i]!;
    }
  }
  let d = `M${px[0]!.toFixed(1)},${py[0]!.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${(px[i]! + h).toFixed(1)},${(py[i]! + t[i]! * h).toFixed(1)} ${(px[i + 1]! - h).toFixed(1)},${(py[i + 1]! - t[i + 1]! * h).toFixed(1)} ${px[i + 1]!.toFixed(1)},${py[i + 1]!.toFixed(1)}`;
  }
  return d;
}

/**
 * График темпа месяца (grafana-style): накопленные траты — плавная линия
 * со свечением и градиентной заливкой; ровный график бюджета — пунктир;
 * вертикаль «сейчас»; полая точка — прогноз итога при текущем темпе.
 * Цвет — «температура»: зелёный в графике, янтарь/красный при перегреве.
 */
function TempoChart({
  daily,
  today,
  dim,
  cap,
  proj,
  color,
}: {
  daily: readonly number[];
  today: number;
  dim: number;
  cap: number;
  proj: number;
  color: string;
}) {
  const W = 320;
  const H = 140;
  const padL = 4;
  const padR = 10;
  const padT = 12;
  const padB = 4;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const cum: number[] = [];
  for (let i = 0; i < dim; i++) cum.push((cum[i - 1] ?? 0) + (daily[i] ?? 0));
  const cumToday = cum[today - 1] ?? 0;
  const yMax = Math.max(cap, proj, cumToday, 1) * 1.07;
  const x = (d: number) => padL + (dim > 1 ? ((d - 1) / (dim - 1)) * plotW : plotW / 2);
  const y = (v: number) => padT + (1 - v / yMax) * plotH;
  const yBase = y(0);
  const px = Array.from({ length: today }, (_, i) => x(i + 1));
  const py = px.map((_, i) => y(cum[i]!));
  const line = smoothPath(px, py);
  const area = `${line}L${x(today).toFixed(1)},${yBase.toFixed(1)}L${px[0]!.toFixed(1)},${yBase.toFixed(1)}Z`;
  const projY = y(Math.min(proj, yMax * 0.97));
  const gridCls = '#3f3f46';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="mt-1 block h-36 w-full" aria-hidden>
      <defs>
        <linearGradient id="tempoFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="60%" stopColor={color} stopOpacity="0.12" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* сетка: половина и потолок бюджета + нулевая ось */}
      {cap > 0 && <line x1={padL} y1={y(cap / 2)} x2={W - padR} y2={y(cap / 2)} stroke={gridCls} strokeWidth="0.7" strokeDasharray="2 4" opacity="0.5" />}
      {cap > 0 && <line x1={padL} y1={y(cap)} x2={W - padR} y2={y(cap)} stroke={gridCls} strokeWidth="0.9" strokeDasharray="4 3" opacity="0.8" />}
      <line x1={padL} y1={yBase} x2={W - padR} y2={yBase} stroke="#52525b" strokeWidth="1" />
      {/* вертикаль «сейчас» — как now-line в Grafana */}
      <line x1={x(today)} y1={padT} x2={x(today)} y2={yBase} stroke="#71717a" strokeWidth="0.9" opacity="0.45" />
      {/* идеал: ровный график «бюджет/день × день» */}
      <line x1={x(1)} y1={yBase} x2={x(dim)} y2={y(cap)} stroke="#a1a1aa" strokeWidth="1.1" strokeDasharray="5 3" opacity="0.75" />
      <path d={area} fill="url(#tempoFill)" />
      {/* свечение + сама линия факта */}
      <path d={line} fill="none" stroke={color} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" opacity="0.18" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      {proj > 0 && (
        <line x1={x(today)} y1={y(cumToday)} x2={x(dim)} y2={projY} stroke={color} strokeWidth="1.6" strokeDasharray="2.5 3" opacity="0.85" />
      )}
      {/* точка «сегодня» с ореолом + кольцо прогноза */}
      <circle cx={x(today)} cy={y(cumToday)} r="6" fill={color} opacity="0.2" />
      <circle cx={x(today)} cy={y(cumToday)} r="3.2" fill={color} stroke="#18181b" strokeWidth="1" />
      {proj > 0 && <circle cx={x(dim)} cy={projY} r="4" fill="#18181b" stroke={color} strokeWidth="1.6" />}
    </svg>
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
        // просроченный срок закрываем оплатой его датой — иначе запись
        // «сегодня» попадёт уже в окно следующего срока (isOccurrencePaid)
        await api.post(`/api/tma/commitments/${item.id}/payments`, {
          client_id,
          ...(item.overdue ? { paid_on: item.due_on } : {}),
        });
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
          {item.cadence ? <span class="text-[13px] text-zinc-500"> · {item.cadence}</span> : ''}
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
  const [openB, setOpenB] = useState(false);

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
  // статус бюджета — единый источник (в «Тратах» только журнал)
  const weekShare = w.week_budget_minor > 0 ? w.week_spent_minor / w.week_budget_minor : 0;
  const spentShare = w.month_cap_minor > 0 ? w.month_spent_minor / w.month_cap_minor : 0;
  const paceHex =
    w.burn_rate <= 1 ? '#34d399' : w.burn_rate <= 1.3 ? '#fbbf24' : '#f87171';
  // прогноз итога месяца при текущем темпе; с 3-го дня — раньше шум
  const projMinor = w.month_day >= 3 ? Math.round((w.month_spent_minor / w.month_day) * w.month_days) : 0;
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
                <PayRow key={`${x.kind}:${x.id}:${x.due_on}`} api={api} item={x} onPaid={() => { nav.flash(`Оплачено: ${x.name}`); up.reload(); ov.reload(); }} />
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
        {/* hero: темп месяца — тап раскрывает детали */}
        <div class="cursor-pointer select-none" onClick={() => setOpenB((v) => !v)}>
          <div class={rowCls}>
            <span class={mutedCls}>
              Темп месяца
              <Info title="Темп месяца">
                Линия — накопленные траты по дням месяца; пунктир — ровный
                график бюджета; полая точка — прогноз итога при текущем
                темпе. Пока линия ниже пунктира — вы в графике; выше и
                краснее — тратите быстрее плана.
              </Info>
            </span>
          </div>
          {w.month_cap_minor > 0 ? (
            <>
              <TempoChart
                daily={w.month_daily_minor}
                today={w.month_day}
                dim={w.month_days}
                cap={w.month_cap_minor}
                proj={projMinor}
                color={paceHex}
              />
              <div class="flex items-center justify-between text-[10px] text-zinc-600">
                <span>1</span>
                <span>день {w.month_day}</span>
                <span>{w.month_days}</span>
              </div>
            </>
          ) : (
            <p class={`${mutedCls} mt-2`}>
              Бюджет месяца не задан — потрачено {fmtMinor(w.month_spent_minor, c)}
            </p>
          )}
          <div class={`${rowCls} mt-1`}>
            <span class={`${mutedCls} text-[12px]`}>
              {projMinor > 0
                ? `прогноз ~${fmtMinor(projMinor, c)} из ${fmtMinor(w.month_cap_minor, c)}`
                : `день ${w.month_day} из ${w.month_days}`}
            </span>
            <span class={`${mutedCls} inline-flex items-center gap-0.5 text-[12px]`}>
              детали
              <ChevronDown
                size={13}
                strokeWidth={1.5}
                class={`transition-transform ${openB ? 'rotate-180' : ''}`}
              />
            </span>
          </div>
        </div>
        {openB && (
          <div class="mt-3 border-t border-white/5 pt-3">
            <div class={rowCls}>
              <span class={mutedCls}>
                Неделя · {fmtDay(w.week_from)} – {fmtDay(w.week_to)}
              </span>
              <b>{fmtMinor(w.week_spent_minor, c)}</b>
            </div>
            <BudgetBar share={weekShare} over={w.week_over} />
            <div class={`${rowCls} mt-2`}>
              <span class={mutedCls}>
                Бюджет недели
                <Info title="Бюджет недели">
                  Равномерная доля месячного бюджета: бюджет месяца × 12/52.
                  Задаётся в профиле («Норма трат»).
                </Info>
              </span>
              <span>{fmtMinor(w.week_budget_minor, c)}</span>
            </div>
            <div class={`${rowCls} mt-2`}>
              <span class={mutedCls}>Остаток</span>
              <span class={w.week_over ? 'text-red-400' : ''}>
                {fmtMinor(w.week_remaining_minor, c)}
                {w.week_over ? ' — перебор' : ''}
              </span>
            </div>
            <div class="my-3 border-t border-white/5" />
            <div class={rowCls}>
              <span class={mutedCls}>Месяц</span>
              <b>{fmtMinor(w.month_spent_minor, c)}</b>
            </div>
            <BudgetBar share={spentShare} />
            <div class={`${rowCls} mt-2`}>
              <span class={mutedCls}>Бюджет месяца</span>
              <span>{fmtMinor(w.month_cap_minor, c)}</span>
            </div>
            <div class={`${rowCls} mt-3`}>
              <span class={mutedCls}>Лимит на день</span>
              <span>
                {fmtMinor(w.daily_allowance_minor, c)} · {w.days_left} дн. до конца месяца
              </span>
            </div>
          </div>
        )}
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
          <Receipt size={18} strokeWidth={1.5} class={iconCls} /> Траты
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
