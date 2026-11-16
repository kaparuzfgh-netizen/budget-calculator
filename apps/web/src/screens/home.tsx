/**
 * home.tsx — «Обзор»: хедер с приветствием и аватаром-профилем,
 * быстрые действия, «К оплате в месяце» с кнопками оплаты,
 * повседневные с прогресс-барами, доход и сетка разделов.
 */
import { useState } from 'preact/hooks';
import { ArrowLeftRight, Banknote, CalendarDays, ChartColumn, ChartPie, ChevronDown, CircleCheck, Handshake, Landmark, Plus, Receipt, User, Users, Wallet } from 'lucide-preact';
import { ApiError } from '../api';
import type { HouseholdResponse, Overview, Upcoming, UpcomingItem, WeekStatus } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinor } from '../fmt';
import { BudgetBar, cardCls, confirmNeutralCls, ErrorView, errorView, headCls, Info, listCardCls, Loading, mutedCls, rowCls, smBtnCls, smGhostBtnCls, smPrimaryBtnCls, useData } from '../ui';
import { paceColor, TEMPO_LABELS, TEMPO_INFO, TempoChart, RaceChart, WeekRace } from './home-tempo';
import type { TempoKind, TempoProps } from './home-tempo';

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

/**
 * «Что делать» — детерминированный совет из фактических трат: разрыв между
 * текущей нормой и лимитом на день закрываем конкретной топ-категорией.
 * Возвращает null, когда бюджет не задан или месяц закончился.
 */
function tempoAdvice(w: WeekStatus, c: string): { text: string; tone: string } | null {
  if (w.month_cap_minor <= 0 || w.days_left <= 0 || w.month_day <= 0) return null;
  const m = (minor: number) => fmtMinor(Math.round(minor), c);
  const allowance = w.daily_allowance_minor;
  const cur = Math.round(w.month_spent_minor / w.month_day);
  const gap = cur - allowance; // >0 — перерасход в день, <0 — запас
  const top = w.month_top?.[0];
  const topDaily = top ? Math.round(top.spent_minor / w.month_day) : 0;
  if (gap <= 0) {
    const topTxt = top ? ` Больше всего уходит на «${top.name}» — ${m(top.spent_minor)} (${Math.round(top.share * 100)}%).` : '';
    return { text: `В графике: держите траты до ${m(allowance)}/день — запас ${m(-gap)}/день.${topTxt}`, tone: 'text-emerald-300/90' };
  }
  if (!top) {
    return { text: `Чтобы вписаться, сократите траты на ${m(gap)}/день.`, tone: 'text-amber-300/90' };
  }
  if (topDaily >= gap) {
    return {
      text: `Больше всего съедает «${top.name}» — ${m(top.spent_minor)} за месяц. Урежьте её на ${m(gap)}/день — вернётесь в график.`,
      tone: 'text-amber-300/90',
    };
  }
  return {
    text: `До графика не хватает ${m(gap)}/день — «${top.name}» целиком даёт только ${m(topDaily)}: придётся резать и другие категории.`,
    tone: 'text-red-300/90',
  };
}

export function HomeScreen({ api, nav, onFatal, name, tempo }: ScreenProps & { name: string | null; tempo?: TempoKind }) {
  const ov = useData(() => api.get<Overview>('/api/tma/overview'), onFatal, []);
  const wk = useData(() => api.get<WeekStatus>('/api/tma/week'), onFatal, []);
  const up = useData(() => api.get<Upcoming>('/api/tma/upcoming'), onFatal, []);
  const hh = useData(() => api.get<HouseholdResponse>('/api/tma/household'), onFatal, []);
  const [openB, setOpenB] = useState(false);
  const [whatIfMinor, setWhatIfMinor] = useState<number | null>(null);
  // вид hero-графика: tempo-проп — стартовый (демо), дальше — выбор в «деталях»
  const [chartKind, setChartKind] = useState<TempoKind>(() => {
    if (tempo) return tempo;
    try {
      const v = localStorage.getItem('bc.tempoChart') as TempoKind | null;
      return v && v in TEMPO_LABELS ? v : 'race';
    } catch {
      return 'race';
    }
  });
  const tempoKind = chartKind;

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
  // общий бюджет — опционально: ошибка/loading не блокируют экран
  const pair = hh.data?.household ?? null;

  const o = ov.data;
  const w = wk.data;
  const u = up.data;
  const c = o.living_currency;
  // статус бюджета — единый источник (в «Тратах» только журнал)
  const spentShare = w.month_cap_minor > 0 ? w.month_spent_minor / w.month_cap_minor : 0;
  // ── НЕДЕЛЯ (hero-инструмент): «Что если» — норма на остаток недели ──
  const weekDay = Math.max(1, Math.min(w.week_day, 7));
  const weekLeftDays = Math.max(0, 7 - weekDay); // дней после сегодня
  const weekCurDaily = w.week_spent_minor / weekDay;
  const effDailyMinor = whatIfMinor ?? weekCurDaily;
  const projWeekMinor = Math.round(w.week_spent_minor + effDailyMinor * weekLeftDays);
  // температура недели: доля бюджета vs доля прошедшего времени
  const weekRate =
    w.week_budget_minor > 0 ? (w.week_spent_minor / w.week_budget_minor) / (weekDay / 7) : 0;
  const scenario = whatIfMinor !== null;
  const scenarioRatio =
    w.week_budget_minor > 0 ? (effDailyMinor * 7) / w.week_budget_minor : 0;
  const projColor = paceColor(scenarioRatio);
  const effRate = scenario ? scenarioRatio : weekRate;
  // недельный «лимит»: остаток недели / дней до конца — риска на ползунке
  const weekAllowance = weekLeftDays > 0 ? Math.max(0, w.week_remaining_minor / weekLeftDays) : 0;
  // ── МЕСЯЦ (контекст в деталях): пассивный прогноз по текущей норме ──
  const monthCurDaily = w.month_day > 0 ? w.month_spent_minor / w.month_day : 0;
  const projMonthMinor =
    w.month_day >= 3
      ? Math.round(w.month_spent_minor + monthCurDaily * (w.month_days - w.month_day))
      : 0;
  const monthStatus =
    w.burn_rate <= 1 ? 'в графике' : w.burn_rate <= 1.3 ? 'чуть быстрее' : 'быстрее плана';
  const paidN = u.items.filter((x) => x.paid).length;
  const monthWord = MONTHS[Number(u.month.slice(5, 7)) - 1]!;

  const quickCls =
    'flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-zinc-900/80 py-3.5 text-[13px] text-zinc-100 shadow-lg shadow-shade transition hover:bg-zinc-800/80';
  const tileCls =
    'flex items-center gap-2.5 rounded-2xl border border-line bg-zinc-900/80 px-4 py-3.5 text-[15px] text-zinc-100 shadow-lg shadow-shade transition hover:bg-zinc-800/80';
  const iconCls = 'text-sky-400';

  return (
    <>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="text-xl font-semibold tracking-tight">Обзор{name ? ` · ${name}` : ''}</h1>
        <button
          type="button"
          class="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-zinc-800 text-base font-semibold text-zinc-100 transition hover:bg-zinc-700"
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
            <ul class="divide-y divide-line-soft">
              {u.items.map((x) => (
                <PayRow key={`${x.kind}:${x.id}:${x.due_on}`} api={api} item={x} onPaid={() => { nav.flash(`Оплачено: ${x.name}`); up.reload(); ov.reload(); }} />
              ))}
            </ul>
            <p class="border-t border-line-soft px-4 py-2.5 text-[13px] text-zinc-500">
              Оплачено {paidN} из {u.items.length}
            </p>
          </div>
        </>
      )}

      <h2 class={`${headCls} mt-6`}>
        <Wallet size={16} strokeWidth={1.5} /> Бюджет
      </h2>
      <div class={`${cardCls} mt-2`}>
        {/* hero: неделя-гонка — инструмент дня; тап раскрывает месяц */}
        <div class="cursor-pointer select-none" onClick={() => setOpenB((v) => !v)}>
          <div class={rowCls}>
            <span class={mutedCls}>
              Неделя · {fmtDay(w.week_from)} – {fmtDay(w.week_to)}
              <Info title="Гонка недели">
                <p>
                  Две шкалы наперегонки: «дни недели» — сколько времени прошло
                  (пн–вс; янтарь — спайк-зона: вечер пятницы и выходные),
                  «бюджет» — сколько потрачено от лимита недели.
                </p>
                <p>
                  Бюджет бежит впереди дней — перебираете. Пунктирная риска —
                  итог недели при текущей норме; штриховка до неё — ползунок
                  «Что если» в деталях.
                </p>
                <p>
                  Недельный лимит — равномерная доля бюджета месяца (×12/52),
                  задаётся в профиле («Норма трат»).
                </p>
              </Info>
            </span>
            <span class={`text-[13px] ${w.week_over ? 'text-red-400' : 'text-zinc-400'}`}>
              {w.week_over
                ? `перебор ${fmtMinor(-w.week_remaining_minor, c)}`
                : `осталось ${fmtMinor(w.week_remaining_minor, c)}`}
            </span>
          </div>
          {w.week_budget_minor > 0 ? (
            <WeekRace
              day={weekDay}
              budget={w.week_budget_minor}
              spent={w.week_spent_minor}
              proj={projWeekMinor}
              rate={weekRate}
              effRate={effRate}
              scenario={scenario}
            />
          ) : (
            <p class={`${mutedCls} mt-2`}>
              Недельный бюджет не задан — потрачено {fmtMinor(w.week_spent_minor, c)}
            </p>
          )}
          <div class={`${rowCls} mt-1`}>
            <span class={`${mutedCls} text-[12px]`} style={scenario ? { color: projColor } : undefined}>
              {weekLeftDays > 0 && w.week_budget_minor > 0
                ? `${scenario ? 'сценарий' : 'итог недели'} ≈ ${fmtMinor(projWeekMinor, c)} из ${fmtMinor(w.week_budget_minor, c)}`
                : 'неделя завершена'}
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
          {/* месяц — компактный статус; график и цифры — в деталях */}
          {w.month_cap_minor > 0 && (
            <p class="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span
                class="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: paceColor(w.burn_rate) }}
              />
              месяц {monthStatus} · лимит {fmtMinor(w.daily_allowance_minor, c)}/день
            </p>
          )}
        </div>
        {openB && (
          <div class="mt-3 border-t border-line-soft pt-3">
            {/* «Что если» — норма на остаток недели; крутит хвост на гонке выше */}
            {w.week_budget_minor > 0 && weekLeftDays > 0 && (
              <div onClick={(e) => e.stopPropagation()}>
                <div class={rowCls}>
                  <span class={mutedCls}>
                    Что если
                    <Info title="Что если">
                      Сценарий: если до конца недели ({weekLeftDays} дн.)
                      тратить по этой норме в день — каким будет итог недели.
                      Риска «лимит» на ползунке — норма, при которой бюджет
                      недели закончится ровно в воскресенье.
                    </Info>
                  </span>
                  <span>
                    {fmtMinor(effDailyMinor, c)}/день
                    {whatIfMinor !== null && (
                      <span class={mutedCls}> · сейчас {fmtMinor(weekCurDaily, c)}</span>
                    )}
                  </span>
                </div>
                {(() => {
                  const maxDaily = Math.max(100, Math.ceil((w.week_budget_minor / 100 / 7) * 3 / 100) * 100);
                  const limitPos = Math.min(weekAllowance / 100 / maxDaily, 1) * 100;
                  return (
                    <>
                      <div class="relative">
                        <input
                          type="range"
                          min={0}
                          max={maxDaily}
                          step={Math.max(10, Math.round(maxDaily / 60))}
                          value={Math.min(Math.round(effDailyMinor / 100), maxDaily)}
                          onInput={(e) => setWhatIfMinor(Number((e.target as HTMLInputElement).value) * 100)}
                          class="mt-2 w-full"
                          style={{ accentColor: projColor }}
                          aria-label="Дневная норма трат на остаток недели"
                        />
                        {/* риска «лимита недели»: правее — бюджет не доживёт до вс */}
                        <div
                          class="pointer-events-none absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded bg-white/60"
                          style={{ left: `${limitPos}%` }}
                        />
                      </div>
                      <p class="mt-0.5 text-center text-[10px] text-zinc-600">︱лимит недели</p>
                    </>
                  );
                })()}
                <div class={`${rowCls} mt-1`}>
                  <span class={`${mutedCls} text-[12px]`}>
                    {effDailyMinor !== weekAllowance
                      ? `${effDailyMinor > weekAllowance ? 'выше' : 'ниже'} лимита на ${fmtMinor(Math.abs(effDailyMinor - weekAllowance), c)}/день · `
                      : ''}
                    итог недели ≈ {fmtMinor(projWeekMinor, c)}
                  </span>
                  {whatIfMinor !== null && (
                    <button type="button" class="text-[12px] text-sky-400" onClick={() => setWhatIfMinor(null)}>
                      сбросить
                    </button>
                  )}
                </div>
              </div>
            )}
            <div class="my-3 border-t border-line-soft" />
            {/* месяц — контекст: график темпа + цифры */}
            <div class={rowCls}>
              <span class={mutedCls}>
                график месяца
                <Info title="График месяца">{TEMPO_INFO[tempoKind]}</Info>
              </span>
              <span class="flex flex-wrap gap-1.5">
                {(Object.keys(TEMPO_LABELS) as TempoKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setChartKind(k);
                      try {
                        localStorage.setItem('bc.tempoChart', k);
                      } catch {
                        // приватный режим — выбор живёт до перезагрузки
                      }
                    }}
                    class={`rounded-full px-2.5 py-1 text-[11px] ${
                      k === tempoKind ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500'
                    }`}
                  >
                    {TEMPO_LABELS[k]}
                  </button>
                ))}
              </span>
            </div>
            {w.month_cap_minor > 0 ? (
              (() => {
                const t: TempoProps = {
                  daily: w.month_daily_minor,
                  today: w.month_day,
                  dim: w.month_days,
                  cap: w.month_cap_minor,
                  spent: w.month_spent_minor,
                  proj: projMonthMinor,
                  rate: w.burn_rate,
                  effRate: w.burn_rate,
                  scenario: false,
                };
                return tempoKind === 'race' ? <RaceChart {...t} /> : <TempoChart {...t} />;
              })()
            ) : (
              <p class={`${mutedCls} mt-2`}>
                Бюджет месяца не задан — потрачено {fmtMinor(w.month_spent_minor, c)}
              </p>
            )}
            <div class={`${rowCls} mt-2`}>
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
            {(() => {
              const adv = tempoAdvice(w, c);
              if (!adv) return null;
              return (
                <p class="mt-1.5 text-[12px] leading-snug">
                  <span class={mutedCls}>Совет · </span>
                  <span class={adv.tone}>{adv.text}</span>
                </p>
              );
            })()}
          </div>
        )}
      </div>

      {pair && (
        <>
          <h2 class={`${headCls} mt-6`}>
            <Users size={16} strokeWidth={1.5} /> Общий бюджет
            <Info title="Бюджет на двоих">
              <p>
                Общий недельный лимит пары — траты обоих считаются вместе.
                Лимит меняется в профиле → «Семья». Траты партнёра видны
                только суммой, без деталей.
              </p>
            </Info>
          </h2>
          <div class={`${cardCls} mt-2`}>
            <div class={rowCls}>
              <span class={mutedCls}>Неделя</span>
              <b class={pair.week_over ? 'text-red-400' : ''}>
                {fmtMinor(pair.spent_week_minor, pair.currency)} / {fmtMinor(pair.weekly_budget_minor, pair.currency)}
              </b>
            </div>
            <BudgetBar share={pair.weekly_budget_minor > 0 ? pair.spent_week_minor / pair.weekly_budget_minor : 0} />
            {pair.members.map((mem) => (
              <div key={mem.user_id} class={`${rowCls} mt-2`}>
                <span class={mutedCls}>{mem.is_me ? 'Вы' : (mem.name ?? 'Партнёр')}</span>
                <span>{fmtMinor(mem.spent_week_minor, pair.currency)}</span>
              </div>
            ))}
            <div class={`${rowCls} mt-2`}>
              <span class={mutedCls}>Лимит месяца</span>
              <span>{fmtMinor(pair.living_cap_minor, pair.currency)}</span>
            </div>
            {pair.fx_note && <p class="mt-1.5 text-[12px] text-amber-400">{pair.fx_note}</p>}
          </div>
        </>
      )}

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
      </div>
    </>
  );
}

export type { TempoKind } from './home-tempo';
