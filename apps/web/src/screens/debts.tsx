/**
 * debts.tsx — «Кредиты» в Mini App (веха H3).
 *
 * DebtsScreen: GET /api/tma/debts — список с replay-состоянием и итогом USD.
 * DebtScreen: GET /api/tma/debts/:id — карточка: операции (Платёж,
 *   ЧДП с превью обоих режимов, Сверка, Правки) раскрываются
 *   инлайн-формами; журнал событий — правка (сумма/дата, у ЧДП режим)
 *   и удаление; удаление кредита с подтверждением.
 * DebtAddScreen: POST /api/tma/debts.
 * Идемпотентность мутаций — client_id на форму (retry не задвоит событие).
 */
import { useState } from 'preact/hooks';
import { CircleCheck, HandCoins, History, Landmark, Pencil, Plus } from 'lucide-preact';
import type { DebtDetail, DebtsList } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, dayError, fmtDay, fmtMinor, nameError, parseAmount } from '../fmt';
import { cardCls, CcySelect, ErrorView, errorView, Field, FormError, h1Cls, headCls, inputCls, liCls, listCardCls, Loading, mutedCls, primaryBtnCls, rowCls, Select, smBtnCls, useData } from '../ui';
import { clientId, apiErr, actionTileCls, actionTileOnCls } from './debt-common';
import { PayForm, PrepayForm, ReconcileForm, EditForm } from './debt-forms';
import { EventRow, DeleteDebt } from './debt-events';

export function DebtsScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<DebtsList>('/api/tma/debts'), onFatal, []);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const d = q.data;
  return (
    <>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Landmark size={20} strokeWidth={1.5} class="text-sky-400" /> Кредиты
        </h1>
        <button type="button" class={smBtnCls} onClick={() => nav.push({ id: 'debt-add' })}>
          <Plus size={14} strokeWidth={1.5} /> Добавить
        </button>
      </div>
      <div class={listCardCls}>
        {d.debts.length ? (
          <ul class="divide-y divide-line-soft">
            {d.debts.map((x) => (
              <li
                class={`${liCls} cursor-pointer transition hover:bg-fill`}
                onClick={() => nav.push({ id: 'debt', debtId: x.id })}
              >
                <div class={rowCls}>
                  <span class="text-[15px] text-zinc-100">{x.name}</span>
                  <span>{fmtMinor(x.balance_minor, x.currency)}</span>
                </div>
                <div class={`${rowCls} mt-1`}>
                  <span class={mutedCls}>
                    {fmtMinor(x.payment_minor, x.currency)}
                    {x.frequency === 'biweekly' ? '/2 нед' : '/мес'}
                    {x.due_day ? ` · ${x.due_day} числа` : ''}
                  </span>
                  <span class={mutedCls}>{x.months_left > 0 ? `~${Math.ceil(x.months_left)} мес` : 'закрыт'}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Кредитов нет. Добавьте первый — остаток, ставка и платёж.</p>
        )}
      </div>
      {d.total_usd_minor !== null && d.debts.length > 0 && (
        <p class={`${mutedCls} mt-2`}>Итого долг: ≈ {fmtMinor(d.total_usd_minor, 'USD')}</p>
      )}
    </>
  );
}

// ── карточка ──

type Action = 'pay' | 'prepay' | 'reconcile' | 'edit' | null;

export function DebtScreen({ api, nav, onFatal, debtId }: ScreenProps & { debtId: number }) {
  const q = useData(() => api.get<DebtDetail>(`/api/tma/debts/${debtId}`), onFatal, [debtId]);
  const [action, setAction] = useState<Action>(null);
  const [openEv, setOpenEv] = useState<number | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  if (!q.data) {
    return <ErrorView title="Кредит не найден" text="Кредит уже удалён." onRetry={nav.back} />;
  }
  const v = q.data;
  const toggle = (a: Action) => {
    setAction(action === a ? null : a);
    setOpenEv(null);
  };
  const done = (msg: string) => {
    setAction(null);
    setOpenEv(null);
    nav.flash(msg);
    q.reload();
  };
  const props = { api, debt: v, done, onFatal };

  return (
    <>
      <h1 class={h1Cls}>{v.name}</h1>
      <div class={cardCls}>
        <div class={rowCls}>
          <span>Остаток</span>
          <span class="text-2xl font-semibold">{fmtMinor(v.balance_minor, v.currency)}</span>
        </div>
        <div class={`${rowCls} mt-2`}>
          <span>Платёж</span>
          <span>
            {fmtMinor(v.payment_minor, v.currency)}
            {v.frequency === 'biweekly' ? '/2 нед' : '/мес'} · ставка {v.rate}%
          </span>
        </div>
        <div class={`${rowCls} mt-2`}>
          <span class={mutedCls}>Платежей: {v.payments_made}</span>
          <span class={mutedCls}>
            {v.months_left > 0 ? `~${Math.ceil(v.months_left)} мес · до ${fmtDay(v.payoff_date)}` : 'погашен'}
          </span>
        </div>
        {v.due_day !== null && (
          <div class={`${rowCls} mt-2`}>
            <span class={mutedCls}>День платежа</span>
            <span class={mutedCls}>{v.due_day} числа</span>
          </div>
        )}
      </div>

      <div class="mt-4 grid grid-cols-2 gap-2.5">
        <button type="button" class={action === 'pay' ? actionTileOnCls : actionTileCls} onClick={() => toggle('pay')}>
          <CircleCheck size={16} strokeWidth={1.5} /> Платёж
        </button>
        <button type="button" class={action === 'prepay' ? actionTileOnCls : actionTileCls} onClick={() => toggle('prepay')}>
          <HandCoins size={16} strokeWidth={1.5} /> ЧДП
        </button>
        <button type="button" class={action === 'reconcile' ? actionTileOnCls : actionTileCls} onClick={() => toggle('reconcile')}>
          <Landmark size={16} strokeWidth={1.5} /> Сверка
        </button>
        <button type="button" class={action === 'edit' ? actionTileOnCls : actionTileCls} onClick={() => toggle('edit')}>
          <Pencil size={16} strokeWidth={1.5} /> Изменить
        </button>
      </div>

      {action === 'pay' && <PayForm {...props} />}
      {action === 'prepay' && <PrepayForm {...props} />}
      {action === 'reconcile' && <ReconcileForm {...props} />}
      {action === 'edit' && <EditForm {...props} />}

      <h2 class={`${headCls} mt-6`}>
        <History size={16} strokeWidth={1.5} /> Журнал
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {v.events.length ? (
          <ul class="divide-y divide-line-soft">
            {[...v.events].reverse().map((e) => (
              <EventRow
                key={e.id}
                api={api}
                ev={e}
                currency={v.currency}
                open={openEv === e.id}
                onToggle={() => setOpenEv(openEv === e.id ? null : e.id)}
                onDone={done}
              />
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Событий пока нет — платежи, ЧДП и сверки появятся здесь.</p>
        )}
      </div>

      <DeleteDebt api={api} nav={nav} debt={v} />
    </>
  );
}

// ── формы операций ──

export function DebtAddScreen({ api, nav }: ScreenProps) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [rate, setRate] = useState('');
  const [payment, setPayment] = useState('');
  const [freq, setFreq] = useState<'monthly' | 'biweekly'>('monthly');
  const [day, setDay] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(clientId); // стабильный client_id на форму — retry не задвоит (P2-3)

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const aErr = amountError(amount);
    const cErr = currencyError(ccy);
    const r = parseAmount(rate);
    const rErr = r === null || r < 0 || r > 100 ? 'Ставка — число 0–100' : null;
    const pErr = amountError(payment);
    const dErr = dayError(day);
    const first = nErr ?? aErr ?? cErr ?? rErr ?? pErr ?? dErr;
    if (first) return setErr(first);
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/debts', {
        name: name.trim(),
        amount: parseAmount(amount),
        currency: ccy.trim().toUpperCase(),
        rate: r,
        payment: parseAmount(payment),
        frequency: freq,
        due_day: day.trim() ? Number(day.trim()) : null,
        client_id: cid,
      });
      nav.flash('Кредит добавлен');
      nav.back();
    } catch (e) {
      setErr(apiErr(e, 'Не удалось добавить — проверьте соединение'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <>
      <h1 class={h1Cls}>
        <Plus size={20} strokeWidth={1.5} class="text-sky-400" /> Кредит
      </h1>
      <div class={cardCls}>
        <form onSubmit={(e) => void submit(e)}>
          <Field label="Название">
            <input class={inputCls} maxLength={60} placeholder="например, Ипотека" value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus />
          </Field>
          <div class="flex gap-3">
            <Field label="Остаток долга">
              <input class={inputCls} inputMode="decimal" placeholder="999000" value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Валюта">
              <CcySelect value={ccy} onChange={setCcy} />
            </Field>
          </div>
          <div class="flex gap-3">
            <Field label="Ставка, % годовых">
              <input class={inputCls} inputMode="decimal" placeholder="12.5" value={rate}
                onInput={(e) => setRate((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Платёж за период">
              <input class={inputCls} inputMode="decimal" placeholder="11000" value={payment}
                onInput={(e) => setPayment((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Периодичность">
              <Select
                value={freq}
                options={[
                  { value: 'monthly', label: 'ежемес.' },
                  { value: 'biweekly', label: 'раз в 2 нед.' },
                ]}
                onChange={(v) => setFreq(v as 'monthly' | 'biweekly')}
              />
            </Field>
          </div>
          <Field
            label={
              <>
                День платежа <span class="text-zinc-500">· 1–31, пусто — без даты</span>
              </>
            }
          >
            <input class={inputCls} inputMode="numeric" maxLength={2} placeholder="—" value={day}
              onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
          </Field>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить кредит'}
          </button>
        </form>
      </div>
    </>
  );
}
