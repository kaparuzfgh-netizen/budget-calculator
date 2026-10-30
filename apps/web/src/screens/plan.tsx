/**
 * plan.tsx — «План» месяца: доход (с источником), обязательные платежи,
 * повседневные и свободный остаток. Все итоговые суммы — в USD
 * (*_usd_minor по контракту). «Указать доход вручную» → повторный
 * GET /api/tma/plan?income=&currency= (источник «задано вручную»).
 */
import { useState } from 'preact/hooks';
import type { IncomeSource, PlanData } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, fmtMinor, parseAmount } from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

const INCOME_SOURCE: Record<IncomeSource, string> = {
  actual: 'факт по записям',
  typical: 'типичный доход',
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

  return (
    <>
      <h1>📊 План · {p.month}</h1>

      <h2>Доход</h2>
      <div class="card">
        <div class="big">{fmtMinor(p.income_minor, p.income_currency)}</div>
        <div class="muted">
          {INCOME_SOURCE[p.income_source]}
          {p.income_entries_count ? ` · записей: ${p.income_entries_count}` : ''}
        </div>
      </div>

      <h2>Обязательные платежи</h2>
      <div class="card">
        {p.commitments.length ? (
          <ul class="plain">
            {p.commitments.map((x) => (
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
        <div class="row">
          <span>Итого платежи</span>
          <b>{fmtMinor(p.mandatory_usd_minor, usd)}</b>
        </div>
      </div>

      <h2>Итог</h2>
      <div class="card">
        <div class="row">
          <span>Повседневные</span>
          <b>{fmtMinor(p.living_usd_minor, usd)}</b>
        </div>
        <div class="row">
          <span>Свободный остаток</span>
          <b class={p.surplus_usd_minor < 0 ? 'err' : ''}>{fmtMinor(p.surplus_usd_minor, usd)}</b>
        </div>
        {p.bonus && (
          <div class="row">
            <span class="muted">Бонус (препей/DCA)</span>
            <span>
              {fmtMinor(p.bonus.prepay_usd_minor, usd)} / {fmtMinor(p.bonus.dca_usd_minor, usd)}
            </span>
          </div>
        )}
      </div>
      <p class="muted">Итоги в базовой валюте USD · курсы на {p.fx_as_of || '—'}</p>

      <h2>Доход вручную</h2>
      <div class="card">
        <form onSubmit={submit}>
          <div class="inline">
            <Field label="Сумма">
              <input
                inputMode="decimal"
                placeholder="например, 7500"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <input
                maxLength={5}
                placeholder={p.income_currency}
                value={ccy}
                onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <FormError msg={err} />
          <div class="inline">
            <button type="submit" class="btn" disabled={busy}>
              Пересчитать
            </button>
            {ovr && (
              <button
                type="button"
                class="btn ghost"
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

