/**
 * plan.tsx — «План» месяца: календарь платежей (кто и когда платить —
 * GET /upcoming), доход (с источником), регулярные платежи, повседневные
 * и свободный остаток. Все итоговые суммы — в USD (*_usd_minor по
 * контракту). «Подушка» — остаток в валюте бюджета vs цель 3 мес
 * (PATCH /profile {cushion}). «Указать доход вручную» → повторный
 * GET /api/tma/plan?income=&currency= (источник «задано вручную»).
 */
import { useState } from 'preact/hooks';
import { Banknote, CalendarClock, CalendarDays, ChartPie, ClipboardList, Pencil, PiggyBank } from 'lucide-preact';
import { ApiError } from '../api';
import type { IncomeSource, PlanData, Upcoming, UpcomingItem } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, fmtMinor, parseAmount } from '../fmt';
import {
  cardCls,
  CcySelect,
  ErrorView,
  errorView,
  Field,
  FormError,
  h1Cls,
  headCls,
  Info,
  inputCls,
  listCardCls,
  Loading,
  mutedCls,
  rowCls,
  smGhostBtnCls,
  smPrimaryBtnCls,
  useData,
} from '../ui';

const INCOME_SOURCE: Record<IncomeSource, string> = {
  actual: 'факт по записям',
  typical: 'базовый доход',
  computed: 'расчёт (обязательства)',
  override: 'задано вручную',
  none: 'не указан',
};

const DAY_MS = 86_400_000;

/** Сколько дней от `today` до срока `due_on` (обе 'YYYY-MM-DD'). */
const daysUntil = (due_on: string, today: string) =>
  Math.round((Date.parse(`${due_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);

/**
 * Строка календаря: день срока + платёж + статус.
 * Порядок items — как в API: неоплаченные по дате, затем оплаченные по дате.
 */
function CalendarRow({ x, today }: { x: UpcomingItem; today: string }) {
  const n = daysUntil(x.due_on, today);
  const status = x.paid
    ? { text: 'оплачено', cls: 'text-emerald-400' }
    : x.overdue
      ? { text: 'просрочено', cls: 'text-red-400' }
      : n === 0
        ? { text: 'сегодня', cls: 'text-amber-300' }
        : n === 1
          ? { text: 'завтра', cls: 'text-zinc-400' }
          : { text: `через ${n} дн`, cls: 'text-zinc-500' };
  const dim = x.paid ? 'text-zinc-500' : '';
  return (
    <li class="flex items-center gap-3 px-4 py-2.5">
      <span
        class={`w-7 flex-none text-center text-lg font-semibold leading-none ${
          x.paid ? 'text-zinc-600' : x.overdue ? 'text-red-400' : 'text-zinc-100'
        }`}
      >
        {Number(x.due_on.slice(8))}
      </span>
      <div class="min-w-0 flex-1">
        <div class={rowCls}>
          <span class={`truncate ${dim}`}>
            {x.name}
            {x.kind === 'debt' ? <span class="text-zinc-500"> · кредит</span> : ''}
          </span>
          <span class={`flex-none ${dim}`}>{fmtMinor(x.amount_minor, x.currency)}</span>
        </div>
        <div class={`mt-0.5 text-xs ${status.cls}`}>{status.text}</div>
      </div>
    </li>
  );
}

/**
 * «Подушка безопасности»: остаток в валюте бюджета, цель — N месяцев
 * обязательных трат + повседневных. Редактор — PATCH /profile {cushion}.
 */
function CushionCard({
  c,
  onSave,
}: {
  c: PlanData['cushion'];
  onSave: (amount: number) => Promise<void>;
}) {
  const [val, setVal] = useState(c.minor ? String(c.minor / 100) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pct = Math.min(100, Math.round((c.months / c.goal_months) * 100));
  const done = c.months >= c.goal_months;

  const save = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(val);
    if (aErr) return setErr(aErr);
    setBusy(true);
    setErr(null);
    try {
      await onSave(parseAmount(val) ?? 0);
      setVal('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div class={`${cardCls} mt-2`}>
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-2xl font-semibold">
          {c.minor ? fmtMinor(c.minor, c.currency) : 'не задана'}
        </span>
        <span class={`text-sm ${done ? 'text-emerald-400' : 'text-zinc-400'}`}>
          {c.months} из {c.goal_months} мес
        </span>
      </div>
      <div class="mt-2 h-2 overflow-hidden rounded-full bg-fill-2">
        <div
          class={`h-full rounded-full transition-all ${done ? 'bg-emerald-400' : 'bg-sky-400'}`}
          style={{ width: `${Math.max(pct, c.minor ? 4 : 0)}%` }}
        />
      </div>
      <p class={`${mutedCls} mt-2`}>
        {c.minor
          ? `Покрывает обязательные платежи и повседневные на ${c.months} мес.`
          : 'Укажите, сколько сейчас отложено — в валюте бюджета.'}
      </p>
      <form onSubmit={save} class="mt-3">
        <div class="flex items-end gap-2">
          <Field label={`Сумма, ${c.currency}`}>
            <input
              class={`${inputCls} h-11`}
              inputMode="decimal"
              placeholder="150000"
              value={val}
              onInput={(e) => setVal((e.target as HTMLInputElement).value)}
            />
          </Field>
          <button
            type="submit"
            class="mb-3 inline-flex h-11 flex-1 items-center justify-center gap-1 rounded-xl bg-sky-600 px-3 text-[15px] font-medium text-white transition hover:bg-sky-500 disabled:opacity-50 disabled:hover:bg-sky-600"
            disabled={busy}
          >
            Сохранить
          </button>
        </div>
        <FormError msg={err} />
      </form>
    </div>
  );
}

export function PlanScreen({ api, onFatal }: ScreenProps) {
  // ручной доход: валидированные значения уходят в query
  const [ovr, setOvr] = useState<{ income: string; currency: string } | null>(null);
  const q = useData(
    () =>
      api.get<PlanData>(
        ovr
          ? `/api/tma/plan?income=${encodeURIComponent(ovr.income)}&currency=${encodeURIComponent(ovr.currency)}`
          : '/api/tma/plan',
      ),
    onFatal,
    [ovr],
  );
  const up = useData(() => api.get<Upcoming>('/api/tma/upcoming'), onFatal, []);

  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(amount);
    const cErr = ccy.trim() ? currencyError(ccy) : null;
    if (aErr || cErr) {
      setErr(aErr ?? cErr);
      return;
    }
    setErr(null);
    setBusy(true);
    // currency: пусто → валюта дохода профиля (берём из уже загруженного плана)
    setOvr({ income: String(parseAmount(amount)), currency: (ccy.trim() || q.data?.income_currency || 'USD').toUpperCase() });
    setBusy(false);
  };

  if (q.loading || up.loading) return <Loading />;
  if (q.error || !q.data || up.error || !up.data) {
    const v = errorView(q.error ?? up.error);
    return (
      <ErrorView
        title={v.title}
        text={v.text}
        onRetry={() => {
          q.reload();
          up.reload();
        }}
      />
    );
  }
  const p = q.data;
  const usd = 'USD';
  // «виртуальный» доход: вычислен из обязательств или подставлен вручную —
  // итоги плана тогда оценочные, а не по факту
  const estimated = p.income_source === 'computed' || p.income_source === 'override';

  return (
    <>
      <h1 class={h1Cls}>
        <ChartPie size={20} strokeWidth={1.5} class="text-sky-400" /> План · {p.month}
      </h1>

      <h2 class={headCls}>
        <CalendarDays size={16} strokeWidth={1.5} /> Календарь платежей
        <Info title="Календарь платежей">
          <p>
            Все регулярные платежи и платежи по кредитам этого месяца — по датам
            срока. Оплаченные — внизу списка.
          </p>
          <p>
            В день срока бот отметит оплату сам, за 2 дня до срока — напомнит
            (если включены «Платежи и сроки» в профиле).
          </p>
        </Info>
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {up.data.items.length ? (
          <ul class="divide-y divide-line-soft">
            {up.data.items.map((x) => (
              <CalendarRow key={`${x.kind}-${x.id}`} x={x} today={p.today} />
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>
            В этом месяце сроков нет — платежи без даты и годовые другого месяца
            сюда не попадают.
          </p>
        )}
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Banknote size={16} strokeWidth={1.5} /> Доход
        <Info title="Откуда берётся доход">
          <p><b>Факт по записям</b> — сумма внесённых доходов за месяц.</p>
          <p><b>Базовый доход</b> — задан в профиле.</p>
          <p><b>Расчёт (обязательства)</b> — оценка: регулярные платежи + бюджет,
            если доход нигде не задан. Итоги тогда ориентировочные.</p>
          <p><b>Задано вручную</b> — пробный пересчёт из формы ниже.</p>
        </Info>
      </h2>
      <div class={`${cardCls} mt-2`}>
        <div class="text-2xl font-semibold">{fmtMinor(p.income_minor, p.income_currency)}</div>
        <div class={`${mutedCls} mt-0.5`}>
          {INCOME_SOURCE[p.income_source]}
          {p.income_entries_count ? ` · записей: ${p.income_entries_count}` : ''}
          {estimated && (
            <span class="ml-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 align-middle text-[10px] font-medium text-amber-300">
              ≈ {p.income_source === 'override' ? 'сценарий' : 'оценка'}
            </span>
          )}
        </div>
      </div>

      <h2 class={`${headCls} mt-6`}>
        <CalendarClock size={16} strokeWidth={1.5} /> Регулярные платежи
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {p.commitments.length ? (
          <ul class="divide-y divide-line-soft">
            {p.commitments.map((x) => (
              <li class="px-4 py-3">
                <div class={rowCls}>
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
          <p class={`${mutedCls} px-4 py-3`}>Нет регулярных платежей.</p>
        )}
        <div class={`${rowCls} border-t border-line-soft px-4 py-3`}>
          <span>Итого</span>
          <b>{fmtMinor(p.mandatory_usd_minor, usd)}</b>
        </div>
      </div>

      <h2 class={`${headCls} mt-6`}>
        <ClipboardList size={16} strokeWidth={1.5} /> Итог
      </h2>
      <div class={`${cardCls} mt-2`}>
        <div class={rowCls}>
          <span>Бюджет</span>
          <b class={estimated ? 'text-amber-300' : ''}>{fmtMinor(p.living_usd_minor, usd)}</b>
        </div>
        <div class={`${rowCls} mt-2`}>
          <span>Свободный остаток</span>
          <b class={p.surplus_usd_minor < 0 ? 'text-red-400' : estimated ? 'text-amber-300' : ''}>
            {fmtMinor(p.surplus_usd_minor, usd)}
          </b>
        </div>
        {p.bonus && (
          <div class={`${rowCls} mt-2`}>
            <span class={mutedCls}>
              Бонус (препей{p.bonus.prepay_target ? ` → «${p.bonus.prepay_target}»` : ''}/DCA)
            </span>
            <span>
              {fmtMinor(p.bonus.prepay_usd_minor, usd)} / {fmtMinor(p.bonus.dca_usd_minor, usd)}
            </span>
          </div>
        )}
      </div>
      <p class={`${mutedCls} mt-2`}>
        Итоги в базовой валюте USD · курсы на {p.fx_as_of || '—'}
        {estimated && <span class="text-amber-300/80"> · ≈ по оценке дохода</span>}
      </p>

      <h2 class={`${headCls} mt-6`}>
        <PiggyBank size={16} strokeWidth={1.5} /> Подушка безопасности
        <Info title="Подушка безопасности">
          <p>
            Запас на чёрный день: сколько месяцев протянете без дохода —
            считается от обязательных платежей и повседневного бюджета.
          </p>
          <p>
            Цель — 3 месяца. Остаток вводится вручную в валюте бюджета;
            отложенное из свободного остатка прибавляйте к текущей сумме.
          </p>
        </Info>
      </h2>
      <CushionCard
        key={`${p.cushion.minor}`}
        c={p.cushion}
        onSave={async (a) => {
          await api.patch('/api/tma/profile', { cushion: a });
          q.reload();
        }}
      />

      <h2 class={`${headCls} mt-6`}>
        <Pencil size={16} strokeWidth={1.5} /> Доход вручную
      </h2>
      <div class={`${cardCls} mt-2`}>
        <p class={`${mutedCls} mb-3`}>
          Пробный пересчёт: подставьте сумму и посмотрите план с другим доходом —
          записи и профиль не меняются.
        </p>
        <form onSubmit={submit}>
          <div class="flex gap-3">
            <Field label="Сумма">
              <input
                class={inputCls}
                inputMode="decimal"
                placeholder="например, 7500"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <CcySelect
                value={ccy}
                onChange={setCcy}
                extra={[p.income_currency]}
                allowEmpty
                emptyLabel={`${p.income_currency} · по умолч.`}
              />
            </Field>
          </div>
          <FormError msg={err} />
          <div class="flex gap-2">
            <button type="submit" class={smPrimaryBtnCls} disabled={busy}>
              Пересчитать
            </button>
            {ovr && (
              <button
                type="button"
                class={smGhostBtnCls}
                onClick={() => {
                  setOvr(null);
                  setAmount('');
                  setCcy('');
                }}
              >
                Сбросить
              </button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
