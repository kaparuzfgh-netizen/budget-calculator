/**
 * invest-trade.tsx — покупка/продажа в журнале позиции (T3d1). Как в обменнике:
 * покупка — «Потратил [сумма] / Получил [количество]», продажа — «Продал [количество] /
 * Получил [сумма]». Сумма вводится С комиссией. Количество и сумма уходят СТРОКАМИ;
 * client_id один на попытку формы (повторная отправка не задвоит сделку).
 * Это учёт, а не инвестиционная рекомендация.
 */
import { useState } from 'preact/hooks';
import { ArrowLeftRight } from 'lucide-preact';
import { ApiError } from '../api';
import type { HoldingsList, TradesView } from '../api';
import type { ScreenProps } from '../app';
import {
  cardCls,
  ErrorView,
  errorView,
  Field,
  FormError,
  h1Cls,
  inputCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  smBtnCls,
  useData,
} from '../ui';
import { buildTradeBody, tradeFormError, type TradeForm } from './invest-common';

const swapCls = 'mb-2 rounded-2xl border border-line bg-zinc-900/60 p-3';
const swapLabelCls = 'mb-1 block text-[12px] text-zinc-500';
const swapInputCls = 'min-w-0 flex-1 bg-transparent text-[24px] font-medium text-zinc-100 outline-none placeholder:text-zinc-600';
const unitCls = 'w-28 shrink-0 text-center text-[16px] font-medium text-zinc-300';

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function TradeFormView({
  api,
  nav,
  holdingId,
  side,
  ticker,
  view,
}: Pick<ScreenProps, 'api' | 'nav'> & { holdingId: number; side: 'buy' | 'sell'; ticker: string; view: TradesView }) {
  const today = todayIso();
  const [f, setF] = useState<TradeForm>({ side, quantity: '', amount: '', tradedOn: today, note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(() => crypto.randomUUID());
  const ccy = view.holding.currency;
  const have = view.holding.quantity;
  const set = <K extends keyof TradeForm>(k: K, v: TradeForm[K]) => setF((s) => ({ ...s, [k]: v }));

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const e0 = tradeFormError(f, have, today);
    if (e0) return setErr(e0);
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/tma/holdings/${holdingId}/trades`, buildTradeBody(f, cid));
      nav.flash(side === 'buy' ? 'Покупка записана' : 'Продажа записана');
      nav.back();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
      setBusy(false);
    }
    return undefined;
  };

  const qtyBlock = (label: string) => (
    <div class={swapCls}>
      <span class={swapLabelCls}>{label}</span>
      <div class="flex items-center gap-3">
        <input
          class={swapInputCls}
          value={f.quantity}
          inputMode="decimal"
          placeholder="0"
          onInput={(e) => set('quantity', (e.target as HTMLInputElement).value)}
        />
        <span class={unitCls}>{ticker || 'шт.'}</span>
      </div>
      {side === 'sell' && have && (
        <div class="mt-1 flex items-center justify-between">
          <span class="text-[12px] text-zinc-500">
            Есть: {have} {ticker || 'шт.'}
          </span>
          <button type="button" class={smBtnCls} onClick={() => set('quantity', have)}>
            Всё
          </button>
        </div>
      )}
    </div>
  );
  const amountBlock = (label: string) => (
    <div class={swapCls}>
      <span class={swapLabelCls}>{label}</span>
      <div class="flex items-center gap-3">
        <input
          class={swapInputCls}
          value={f.amount}
          inputMode="decimal"
          placeholder="0"
          onInput={(e) => set('amount', (e.target as HTMLInputElement).value)}
        />
        <span class={unitCls}>{ccy}</span>
      </div>
    </div>
  );

  return (
    <>
      <h1 class={h1Cls}>
        <ArrowLeftRight size={20} strokeWidth={1.5} class="text-sky-400" /> {side === 'buy' ? 'Покупка' : 'Продажа'}
      </h1>
      <div class={cardCls}>
        <form onSubmit={(e) => void submit(e)}>
          {side === 'buy' ? (
            <>
              {amountBlock('Потратил')}
              {qtyBlock('Получил')}
            </>
          ) : (
            <>
              {qtyBlock('Продал')}
              {amountBlock('Получил')}
            </>
          )}
          <p class={`${mutedCls} mb-3`}>Сумму вводите с комиссией — сколько реально ушло / пришло.</p>
          <Field label="Дата">
            <input class={inputCls} type="date" max={today} value={f.tradedOn} onInput={(e) => set('tradedOn', (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Заметка (необязательно)">
            <input class={inputCls} maxLength={200} value={f.note} onInput={(e) => set('note', (e.target as HTMLInputElement).value)} />
          </Field>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Сохраняю…' : side === 'buy' ? 'Записать покупку' : 'Записать продажу'}
          </button>
        </form>
      </div>
      <p class={`${mutedCls} mt-4`}>Это учёт, а не инвестиционная рекомендация.</p>
    </>
  );
}

export function InvestTradeScreen({ api, nav, onFatal, holdingId, side }: ScreenProps & { holdingId: number; side: 'buy' | 'sell' }) {
  const q = useData(
    async () => {
      const [view, list] = await Promise.all([
        api.get<TradesView>(`/api/tma/holdings/${holdingId}/trades`),
        api.get<HoldingsList>('/api/tma/holdings'),
      ]);
      return { view, ticker: list.items.find((x) => x.id === holdingId)?.ticker ?? '' };
    },
    onFatal,
    [holdingId],
  );
  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  return <TradeFormView api={api} nav={nav} holdingId={holdingId} side={side} ticker={q.data.ticker} view={q.data.view} />;
}
