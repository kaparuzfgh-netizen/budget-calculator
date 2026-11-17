/**
 * invest-form.tsx — добавление/правка позиции портфеля (T3a).
 * Поля зависят от вида: крипта/акции/облигации — количество и «потрачено всего» (+ цена сейчас, если автоцены нет),
 * вклад/другое — сумма (+ ставка и даты для вклада). client_id один на
 * попытку (повторная отправка не задвоит позицию). Удаление — с подтверждением.
 */
import { useState } from 'preact/hooks';
import { Briefcase, Trash2 } from 'lucide-preact';
import { ApiError } from '../api';
import type { HoldingItem, HoldingKind, HoldingsList } from '../api';
import type { ScreenProps } from '../app';
import {
  cardCls,
  CcySelect,
  dangerBtnCls,
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
import {
  buildBody,
  emptyForm,
  formError,
  needsPrice,
  KIND_LABEL,
  KINDS,
  usesQty,
  usesRate,
  type HoldingForm,
} from './invest-common';

const tileCls =
  'flex items-center justify-center rounded-xl border border-line bg-zinc-900/80 py-2.5 text-[14px] font-medium text-zinc-100 transition hover:bg-zinc-800/80';
const tileOnCls =
  'flex items-center justify-center rounded-xl border border-sky-500/60 bg-sky-500/15 py-2.5 text-[14px] font-medium text-sky-300';

const fromItem = (h: HoldingItem): HoldingForm => ({
  kind: h.kind,
  name: h.name,
  ticker: h.ticker ?? '',
  currency: h.currency,
  quantity: h.quantity ?? '',
  invested: h.invested ?? '',
  price: h.price ?? '',
  amount: h.amount_minor === null ? '' : String(h.amount_minor / 100),
  rate: h.rate === null ? '' : String(h.rate),
  openedOn: h.opened_on ?? '',
  maturesOn: h.matures_on ?? '',
  note: h.note ?? '',
});

function HoldingFormView({
  api,
  nav,
  original,
  holdingId,
  supported,
}: Pick<ScreenProps, 'api' | 'nav'> & { original: HoldingForm | null; holdingId?: number; supported: string[] }) {
  const [f, setF] = useState<HoldingForm>(original ?? emptyForm());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [cid] = useState(() => crypto.randomUUID()); // client_id на попытку формы
  const edit = holdingId !== undefined;
  const set = <K extends keyof HoldingForm>(k: K, v: HoldingForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const txt = (k: keyof HoldingForm, props: Record<string, unknown> = {}) => (
    <input
      class={inputCls}
      value={f[k]}
      onInput={(e) => set(k, (e.target as HTMLInputElement).value as never)}
      {...props}
    />
  );

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const e0 = formError(f, supported);
    if (e0) return setErr(e0);
    setBusy(true);
    setErr(null);
    try {
      if (edit) {
        await api.patch(`/api/tma/holdings/${holdingId}`, buildBody(f, { original: original!, supported }));
        nav.flash('Позиция обновлена');
      } else {
        await api.post('/api/tma/holdings', buildBody(f, { clientId: cid, supported }));
        nav.flash('Позиция добавлена');
      }
      nav.back();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
      setBusy(false);
    }
    return undefined;
  };

  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/holdings/${holdingId}`);
      nav.flash('Позиция удалена');
      nav.back();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить — проверьте соединение');
      setBusy(false);
    }
  };

  return (
    <>
      <h1 class={h1Cls}>
        <Briefcase size={20} strokeWidth={1.5} class="text-sky-400" /> {edit ? 'Позиция' : 'Новая позиция'}
      </h1>
      <div class={cardCls}>
        <form onSubmit={(e) => void submit(e)}>
          {!edit && (
            <Field label="Вид">
              <div class="grid grid-cols-3 gap-2">
                {KINDS.map((k: HoldingKind) => (
                  <button type="button" class={f.kind === k ? tileOnCls : tileCls} onClick={() => set('kind', k)}>
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Название">{txt('name', { maxLength: 60, placeholder: 'например, Вклад в банке', autoFocus: !edit })}</Field>
          <div class="flex gap-3">
            <Field label="Валюта">
              <CcySelect value={f.currency} onChange={(v) => set('currency', v)} />
            </Field>
            {usesQty(f.kind) && <Field label="Тикер (необяз.)">{txt('ticker', { maxLength: 12, placeholder: 'BTC' })}</Field>}
          </div>

          {usesQty(f.kind) ? (
            <>
              <Field label="Количество">{txt('quantity', { inputMode: 'decimal', placeholder: '0,002' })}</Field>
              <Field label="Потрачено всего">{txt('invested', { inputMode: 'decimal', placeholder: '128' })}</Field>
              <p class={`${mutedCls} mb-3`}>Сколько вы заплатили за всё количество (в валюте выше).</p>
              {needsPrice(f, supported) ? (
                <Field label="Цена сейчас (за единицу)">{txt('price', { inputMode: 'decimal', placeholder: '30000' })}</Field>
              ) : (
                <p class={`${mutedCls} mb-3`}>Цену этой монеты приложение берёт само.</p>
              )}
            </>
          ) : (
            <Field label="Сумма">{txt('amount', { inputMode: 'decimal', placeholder: '100000' })}</Field>
          )}

          {usesRate(f.kind) && <Field label="Ставка, % годовых">{txt('rate', { inputMode: 'decimal', placeholder: '12' })}</Field>}
          {(f.kind === 'deposit' || f.kind === 'bond') && (
            <div class="flex gap-3">
              <Field label="Открыт">
                <input class={inputCls} type="date" value={f.openedOn} onInput={(e) => set('openedOn', (e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Окончание">
                <input class={inputCls} type="date" value={f.maturesOn} onInput={(e) => set('maturesOn', (e.target as HTMLInputElement).value)} />
              </Field>
            </div>
          )}
          <Field label="Заметка (необязательно)">{txt('note', { maxLength: 200 })}</Field>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Сохраняю…' : edit ? 'Сохранить' : 'Добавить позицию'}
          </button>
        </form>
      </div>
      {edit && (
        <div class="mt-4">
          {confirmDel ? (
            <div class="flex gap-2">
              <button type="button" class={`${dangerBtnCls} flex-1`} disabled={busy} onClick={() => void del()}>
                Точно удалить?
              </button>
              <button type="button" class={smBtnCls} onClick={() => setConfirmDel(false)}>
                Нет
              </button>
            </div>
          ) : (
            <button type="button" class={dangerBtnCls} disabled={busy} onClick={() => setConfirmDel(true)}>
              <Trash2 size={16} strokeWidth={1.5} /> Удалить позицию
            </button>
          )}
        </div>
      )}
      <p class={`${mutedCls} mt-4`}>Это учёт, а не инвестиционная рекомендация.</p>
    </>
  );
}

export function InvestFormScreen({ api, nav, onFatal, holdingId }: ScreenProps & { holdingId?: number }) {
  // позицию (правка) и список поддерживаемых тикеров берём из общего GET (отдельного GET /:id нет)
  const q = useData(
    () => api.get<HoldingsList>('/api/tma/holdings'),
    onFatal,
    [holdingId],
  );
  if (q.loading) return <Loading />;
  if (q.error) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const item = holdingId === undefined ? null : q.data?.items.find((x) => x.id === holdingId);
  const supported = q.data?.auto.supported_tickers ?? [];
  if (holdingId !== undefined && !item) {
    return <ErrorView title="Позиция не найдена" text="Возможно, она уже удалена." onRetry={() => nav.back()} />;
  }
  return <HoldingFormView api={api} nav={nav} original={item ? fromItem(item) : null} supported={supported} {...(holdingId !== undefined ? { holdingId } : {})} />;
}
