/**
 * plan.tsx — «План» месяца: доход (с источником), регулярные платежи,
 * повседневные и свободный остаток. Все итоговые суммы — в USD
 * (*_usd_minor по контракту). «Указать доход вручную» → повторный
 * GET /api/tma/plan?income=&currency= (источник «задано вручную»).
 */
import { useState } from 'preact/hooks';
import { Banknote, CalendarClock, ChartPie, ClipboardList, Pencil } from 'lucide-preact';
import type { IncomeSource, PlanData } from '../api';
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

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
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
          <ul class="divide-y divide-white/5">
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
        <div class={`${rowCls} border-t border-white/5 px-4 py-3`}>
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
            <span class={mutedCls}>Бонус (препей/DCA)</span>
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
