import { useRef, useState } from 'preact/hooks';
import { Camera, Hourglass, TrendingDown } from 'lucide-preact';
import { isAuthError } from '../api';
import type { Api, DebtDetail, PrepayPreview, VisionAnalyzeResponse } from '../api';
import { amountError, dayError, fmtMinor, nameError, parseAmount } from '../fmt';
import { cardCls, Field, FormError, ghostBtnCls, inputCls, mutedCls, primaryBtnCls, rowCls, secondaryBtnCls, smPrimaryBtnCls } from '../ui';
import { MAX_IMAGE_BYTES, visionErrorText } from './vision';
import { clientId, todayIso, apiErr } from './debt-common';

interface FormProps {
  api: Api;
  debt: DebtDetail;
  done: (msg: string) => void;
  onFatal: () => void;
}

/** Общие куски формы события: сумма + дата. */
function useEventForm() {
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(clientId); // стабильный client_id на форму — retry не задвоит
  return { amount, setAmount, on, setOn, err, setErr, busy, setBusy, cid };
}

export function PayForm({ api, debt, done }: FormProps) {
  const f = useEventForm();
  const submit = async (ev: Event, amountOverride?: number) => {
    ev.preventDefault();
    const a = amountOverride ?? parseAmount(f.amount);
    if (a === null || a <= 0 || a > 1e9) return f.setErr(amountError(f.amount) ?? 'Сумма недопустима');
    f.setBusy(true);
    f.setErr(null);
    try {
      await api.post(`/api/tma/debts/${debt.id}/events`, {
        kind: 'payment', amount: a, event_on: f.on, client_id: f.cid,
      });
      done('Платёж записан');
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      f.setBusy(false);
    }
    return undefined;
  };
  const scheduled = debt.payment_minor / 100;
  return (
    <div class={`${cardCls} mt-3`}>
      <form onSubmit={(e) => void submit(e)}>
        <div class="flex gap-3">
          <Field
            label={
              <>
                Сумма <span class="text-zinc-500">· по графику {fmtMinor(debt.payment_minor, debt.currency)}</span>
              </>
            }
          >
            <input class={inputCls} inputMode="decimal" placeholder={String(scheduled)} value={f.amount}
              onInput={(e) => f.setAmount((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input class={inputCls} type="date" value={f.on} onInput={(e) => f.setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={f.err} />
        <div class="flex gap-2">
          <button type="submit" class={primaryBtnCls} disabled={f.busy}>Записать</button>
          <button type="button" class={ghostBtnCls} disabled={f.busy} onClick={(e) => void submit(e, scheduled)}>
            По графику
          </button>
        </div>
      </form>
    </div>
  );
}

export function PrepayForm({ api, debt, done }: FormProps) {
  const f = useEventForm();
  const [preview, setPreview] = useState<PrepayPreview | null>(null);

  const showPreview = async (ev: Event) => {
    ev.preventDefault();
    const a = parseAmount(f.amount);
    if (a === null || a <= 0 || a > debt.balance_minor / 100) {
      setPreview(null);
      return f.setErr(a === null || a <= 0 ? 'Сумма — число больше нуля' : 'Сумма больше остатка долга');
    }
    f.setBusy(true);
    f.setErr(null);
    try {
      setPreview(await api.get<PrepayPreview>(`/api/tma/debts/${debt.id}/prepay-preview?amount=${a}`));
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось посчитать — проверьте соединение'));
      setPreview(null);
    } finally {
      f.setBusy(false);
    }
  };

  const record = async (mode: 'reduce_payment' | 'reduce_term') => {
    f.setBusy(true);
    f.setErr(null);
    try {
      await api.post(`/api/tma/debts/${debt.id}/events`, {
        kind: 'prepay', amount: parseAmount(f.amount), event_on: f.on, mode, client_id: f.cid,
      });
      done('ЧДП записан');
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      f.setBusy(false);
    }
  };

  return (
    <div class={`${cardCls} mt-3`}>
      <form onSubmit={(e) => void showPreview(e)}>
        <div class="flex gap-3">
          <Field label="Сумма ЧДП">
            <input class={inputCls} inputMode="decimal" value={f.amount}
              onInput={(e) => f.setAmount((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input class={inputCls} type="date" value={f.on} onInput={(e) => f.setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={f.err} />
        <button type="submit" class={ghostBtnCls} disabled={f.busy}>
          Посчитать
        </button>
      </form>
      {preview && (
        <div class="mt-3 border-t border-line pt-3">
          <div class={rowCls}>
            <span>Остаток</span>
            <span>
              {fmtMinor(preview.balance_before_minor, debt.currency)} →{' '}
              {fmtMinor(preview.balance_after_minor, debt.currency)}
            </span>
          </div>
          <div class={`${rowCls} mt-2`}>
            <span class="flex items-center gap-1.5">
              <TrendingDown size={15} strokeWidth={1.5} class="text-zinc-400" /> Платёж↓
            </span>
            <span>
              {fmtMinor(preview.payment_before_minor, debt.currency)} →{' '}
              {fmtMinor(preview.payment_after_minor, debt.currency)}
            </span>
          </div>
          <div class={`${rowCls} mt-2`}>
            <span class="flex items-center gap-1.5">
              <Hourglass size={15} strokeWidth={1.5} class="text-zinc-400" /> Срок↓
            </span>
            <span>−{preview.months_saved} мес при том же платеже</span>
          </div>
          <p class={`${mutedCls} mb-2 mt-3`}>Что уменьшаем?</p>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" class={smPrimaryBtnCls} disabled={f.busy} onClick={() => void record('reduce_payment')}>
              <span class="flex flex-col items-center gap-0.5">
                <span class="flex items-center gap-1.5">
                  <TrendingDown size={14} strokeWidth={1.5} /> Платёж
                </span>
                <span class="text-xs font-normal text-sky-200">
                  −{fmtMinor(preview.payment_saved_minor, debt.currency)}
                </span>
              </span>
            </button>
            <button type="button" class={smPrimaryBtnCls} disabled={f.busy} onClick={() => void record('reduce_term')}>
              <span class="flex flex-col items-center gap-0.5">
                <span class="flex items-center gap-1.5">
                  <Hourglass size={14} strokeWidth={1.5} /> Срок
                </span>
                <span class="text-xs font-normal text-sky-200">−{preview.months_saved} мес</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReconcileForm({ api, debt, done, onFatal }: FormProps) {
  const f = useEventForm();
  const submit = async (ev: Event) => {
    ev.preventDefault();
    const a = parseAmount(f.amount);
    if (a === null || a < 0 || a > 1e9) return f.setErr('Остаток — число ≥ 0');
    f.setBusy(true);
    f.setErr(null);
    try {
      await api.post(`/api/tma/debts/${debt.id}/events`, {
        kind: 'reconcile', amount: a, event_on: f.on, client_id: f.cid,
      });
      done('Сверка записана — график пересчитан с фактического остатка');
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      f.setBusy(false);
    }
    return undefined;
  };
  return (
    <div class={`${cardCls} mt-3`}>
      <form onSubmit={(e) => void submit(e)}>
        <div class="flex gap-3">
          <Field label="Остаток по выписке">
            <input class={inputCls} inputMode="decimal" placeholder={String(debt.balance_minor / 100)} value={f.amount}
              onInput={(e) => f.setAmount((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input class={inputCls} type="date" value={f.on} onInput={(e) => f.setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <p class={`${mutedCls} mb-3`}>В приложении сейчас: {fmtMinor(debt.balance_minor, debt.currency)}</p>
        <ReconcileShot api={api} currency={debt.currency} onFatal={onFatal} onFill={(a) => f.setAmount(String(a))} />
        <FormError msg={f.err} />
        <button type="submit" class={primaryBtnCls} disabled={f.busy}>Записать сверку</button>
      </form>
    </div>
  );
}

/**
 * «Заполнить по выписке»: скриншот экрана кредита из банковского приложения →
 * /vision/analyze → screen_type 'debt_balance' → остаток подставляется в поле.
 * Запись — только через «Записать сверку»: пользователь проверяет сумму.
 * Фича opt-in: без vision_enabled сервер отвечает 'disabled' → подсказка.
 */
function ReconcileShot({
  api,
  currency,
  onFill,
  onFatal,
}: {
  api: Api;
  currency: string;
  onFill: (amount: number) => void;
  onFatal: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setErr('Файл больше 10 МБ — выберите скриншот поменьше');
      return;
    }
    const buf = await file.arrayBuffer();
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const res = await api.postRaw<VisionAnalyzeResponse>(
        '/api/tma/vision/analyze',
        buf,
        file.type || 'application/octet-stream',
      );
      const r = res.result;
      if (r.screen_type === 'debt_balance' && r.debt_balance > 0) {
        onFill(r.debt_balance);
        setNote(
          r.currency && r.currency !== currency
            ? `На выписке валюта ${r.currency}, а кредит — ${currency}: проверьте сумму вручную`
            : 'Остаток подставлен — проверьте и нажмите «Записать сверку»',
        );
      } else {
        setErr('Это не похоже на экран кредита с остатком долга — введите сумму вручную');
      }
    } catch (e) {
      if (isAuthError(e)) {
        onFatal();
        return;
      }
      setErr(visionErrorText(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        class="hidden"
        onChange={(e) => void onFile((e.target as HTMLInputElement).files?.[0])}
      />
      <button type="button" class={`${secondaryBtnCls} mb-1`} disabled={busy} onClick={() => fileRef.current?.click()}>
        <Camera size={16} strokeWidth={1.5} /> {busy ? 'Распознаю выписку…' : 'Заполнить по выписке'}
      </button>
      <p class={`${mutedCls} mb-3`}>Скриншот экрана кредита из банковского приложения — остаток подставится в поле.</p>
      {note ? <p class="mb-3 text-[13px] text-sky-300">{note}</p> : null}
      <FormError msg={err} />
    </>
  );
}

export function EditForm({ api, debt, done }: FormProps) {
  const [name, setName] = useState(debt.name);
  const [rate, setRate] = useState(String(debt.rate));
  const [payment, setPayment] = useState(String(debt.payment_minor / 100));
  const [day, setDay] = useState(debt.due_day ? String(debt.due_day) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const r = parseAmount(rate);
    const rErr = r === null || r < 0 || r > 100 ? 'Ставка — число 0–100' : null;
    const pErr = amountError(payment);
    const dErr = dayError(day);
    const first = nErr ?? rErr ?? pErr ?? dErr;
    if (first) return setErr(first);
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/debts/${debt.id}`, {
        name: name.trim(),
        rate: r,
        payment: parseAmount(payment),
        due_day: day.trim() ? Number(day.trim()) : null,
      });
      done('Параметры обновлены');
    } catch (e) {
      setErr(apiErr(e, 'Не удалось сохранить — проверьте соединение'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div class={`${cardCls} mt-3`}>
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Название">
          <input class={inputCls} maxLength={60} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <div class="flex gap-3">
          <Field label="Ставка, % годовых">
            <input class={inputCls} inputMode="decimal" value={rate} onInput={(e) => setRate((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Платёж за период">
            <input class={inputCls} inputMode="decimal" value={payment} onInput={(e) => setPayment((e.target as HTMLInputElement).value)} />
          </Field>
          <Field
            label={
              <>
                День <span class="text-zinc-500">· пусто — без даты</span>
              </>
            }
          >
            <input class={inputCls} inputMode="numeric" maxLength={2} placeholder="—" value={day}
              onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={err} />
        <button type="submit" class={primaryBtnCls} disabled={busy}>Сохранить</button>
      </form>
    </div>
  );
}

// ── журнал ──
