/**
 * invest-form.tsx — добавление/правка позиции портфеля (T3a).
 * Поля зависят от вида: крипта/акции/облигации — количество и «потрачено всего» (+ цена сейчас, если автоцены нет),
 * вклад/другое — сумма (+ ставка и даты для вклада). client_id один на
 * попытку (повторная отправка не задвоит позицию). Удаление — с подтверждением.
 */
import { useEffect, useState } from 'preact/hooks';
import { Briefcase, Trash2 } from 'lucide-preact';
import { ApiError } from '../api';
import type { HoldingItem, HoldingKind, HoldingsList, MoexLookupItem, TradesView } from '../api';
import { fmtDay, fmtMinor } from '../fmt';
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
  Select,
  type SelectOption,
  smBtnCls,
  useData,
} from '../ui';
import {
  buildBody,
  emptyForm,
  formError,
  isLocked,
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

const TICKER_CUSTOM = '__ticker_custom__';

/**
 * Тикер справа от количества. Крипта — выпадающий список монет с автоценой
 * (как выбор валюты) + «Другое…» для ручного ввода; акции/облигации — свободный ввод.
 */
function TickerField({
  kind,
  value,
  supported,
  onChange,
}: {
  kind: HoldingKind;
  value: string;
  supported: string[];
  onChange: (v: string) => void;
}) {
  const up = value.toUpperCase();
  const [custom, setCustom] = useState(!!value && !supported.includes(up));
  const free = (
    <input
      class={`${inputCls} text-center font-medium uppercase`}
      maxLength={12}
      placeholder="Тикер"
      value={value}
      onInput={(e) => onChange((e.target as HTMLInputElement).value.toUpperCase())}
    />
  );
  if (kind !== 'crypto') return free;
  const options: SelectOption[] = [
    ...supported.map((t) => ({ value: t, label: t })),
    { value: TICKER_CUSTOM, label: 'Другое…' },
  ];
  return (
    <div>
      <Select
        value={custom ? TICKER_CUSTOM : up}
        options={options}
        searchable
        placeholder="Тикер"
        onChange={(v) => {
          if (v === TICKER_CUSTOM) {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(v);
          }
        }}
      />
      {custom && <div class="mt-2">{free}</div>}
    </div>
  );
}

const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 400;

/**
 * Поиск бумаги на Мосбирже (акция/облигация): название, тикер или ISIN → список до 10 бумаг;
 * выбор подставляет тикер, название (если пусто) и валюту. Тикер можно ввести и вручную
 * (поле «Получил»). Тумблер «Автоцены» выключен или биржа недоступна — просто ручной ввод.
 */
function MoexSearch({
  api,
  kind,
  enabled,
  onPick,
}: {
  api: ScreenProps['api'];
  kind: 'stock' | 'bond';
  enabled: boolean;
  onPick: (it: MoexLookupItem) => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MoexLookupItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setItems([]);
    setNote(null);
    const t = q.trim();
    if (!enabled || t.length < SEARCH_MIN) return undefined;
    let cancelled = false;
    const id = setTimeout(() => {
      api
        .get<{ items: MoexLookupItem[] }>(`/api/tma/holdings/lookup?kind=${kind}&q=${encodeURIComponent(t)}`)
        .then((r) => {
          if (cancelled) return;
          setItems(r.items);
          if (!r.items.length) setNote('Ничего не найдено — введите тикер вручную ниже.');
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setNote(
            e instanceof ApiError && e.status === 409
              ? 'Включите «Автоцены» в профиле, чтобы искать бумаги.'
              : 'Поиск на бирже недоступен — введите тикер вручную ниже.',
          );
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q, kind, enabled]);
  return (
    <Field label="Найти на Мосбирже (название, тикер или ISIN)">
      <input
        class={inputCls}
        maxLength={32}
        placeholder={kind === 'bond' ? 'например, ОФЗ 26238' : 'например, Сбербанк или SBER'}
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
      />
      {items.length > 0 && (
        <ul class="mt-2 divide-y divide-line rounded-xl border border-line">
          {items.map((it) => (
            <li>
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[14px] text-zinc-100 hover:bg-fill"
                onClick={() => {
                  onPick(it);
                  setQ('');
                }}
              >
                <span class="truncate">
                  {it.secid} · {it.name}
                </span>
                <span class="shrink-0 text-zinc-500">{it.currency}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p class={`${mutedCls} mt-2`}>{note}</p>}
    </Field>
  );
}

const swapCls = 'mb-2 rounded-2xl border border-line bg-zinc-900/60 p-3';
const swapLabelCls = 'mb-1 block text-[12px] text-zinc-500';
const swapInputCls = 'min-w-0 flex-1 bg-transparent text-[24px] font-medium text-zinc-100 outline-none placeholder:text-zinc-600';

const resultText = (minor: number, ccy: string): string => `${minor >= 0 ? '+' : ''}${fmtMinor(minor, ccy)}`;
const resultCls = (minor: number): string => (minor >= 0 ? 'text-emerald-400' : 'text-red-400');

/** Блок «Сделки» (T3d1): купить/продать и журнал с удалением (с подтверждением). */
function TradesBlock({
  api,
  nav,
  item,
  onChanged,
}: Pick<ScreenProps, 'api' | 'nav'> & { item: HoldingItem; onChanged: () => void }) {
  const has = item.trades_count > 0;
  const q = useData(
    () => (has ? api.get<TradesView>(`/api/tma/holdings/${item.id}/trades`) : Promise.resolve(null)),
    () => undefined,
    [item.id, item.trades_count],
  );
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ticker = item.ticker ?? 'шт.';
  const remove = async (id: number) => {
    setBusy(true);
    setErr(null);
    try {
      await api.del(`/api/tma/holdings/${item.id}/trades/${id}`);
      setConfirmId(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить — проверьте соединение');
    }
    setBusy(false);
  };
  const items = q.data ? [...q.data.items].reverse() : [];
  return (
    <>
      <h2 class="mb-2 mt-6 text-[15px] font-semibold">Сделки</h2>
      <div class={cardCls}>
        <div class="flex gap-2">
          <button type="button" class={`${smBtnCls} flex-1 justify-center`} onClick={() => nav.push({ id: 'invest-trade', holdingId: item.id, side: 'buy' })}>
            Купить ещё
          </button>
          {!item.closed_on && (
            <button type="button" class={`${smBtnCls} flex-1 justify-center`} onClick={() => nav.push({ id: 'invest-trade', holdingId: item.id, side: 'sell' })}>
              Продать
            </button>
          )}
        </div>
        <p class={`${mutedCls} mt-2`}>Результат продажи = выручка − средняя цена покупки × количество.</p>
        {has && q.loading && <p class={`${mutedCls} mt-2`}>Загружаю…</p>}
        {has && q.error ? <p class={`${mutedCls} mt-2`}>Не удалось загрузить сделки.</p> : null}
        {items.length > 0 && (
          <ul class="mt-3 divide-y divide-line-soft">
            {items.map((t) => (
              <li class="py-2">
                <div class="flex items-start justify-between gap-2">
                  <span class="text-[14px] text-zinc-100">
                    {fmtDay(t.traded_on)} · {t.initial ? 'начальная запись:' : t.side === 'buy' ? 'купил' : 'продал'} {t.quantity} {ticker} за {t.amount}{' '}
                    {item.currency}
                    {t.unit_price ? ` (≈ ${t.unit_price} за 1)` : ''}
                    {t.realized_minor !== null && (
                      <span class={resultCls(t.realized_minor)}> · {resultText(t.realized_minor, item.currency)}</span>
                    )}
                  </span>
                  {!t.initial &&
                    (confirmId === t.id ? (
                      <span class="flex shrink-0 gap-1">
                        <button type="button" class={dangerBtnCls} disabled={busy} onClick={() => void remove(t.id)}>
                          Удалить сделку?
                        </button>
                        <button type="button" class={smBtnCls} onClick={() => setConfirmId(null)}>
                          Нет
                        </button>
                      </span>
                    ) : (
                      <button type="button" class="shrink-0 p-1 text-zinc-500 hover:text-red-400" aria-label="Удалить сделку" onClick={() => setConfirmId(t.id)}>
                        <Trash2 size={16} strokeWidth={1.5} />
                      </button>
                    ))}
                </div>
                {t.note && <span class="block text-[12px] text-zinc-500">{t.note}</span>}
              </li>
            ))}
          </ul>
        )}
        <FormError msg={err} />
      </div>
    </>
  );
}

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
  autoEnabled,
  item,
  onChanged,
}: Pick<ScreenProps, 'api' | 'nav'> & {
  original: HoldingForm | null;
  holdingId?: number;
  supported: string[];
  autoEnabled: boolean;
  item: HoldingItem | null;
  onChanged: () => void;
}) {
  const [f, setF] = useState<HoldingForm>(original ?? emptyForm());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [cid] = useState(() => crypto.randomUUID()); // client_id на попытку формы
  const edit = holdingId !== undefined;
  const locked = edit && isLocked(item); // есть журнал: количество, «потрачено», валюта — только сделками
  const closed = edit && !!item?.closed_on;
  const tradable = edit && (f.kind === 'crypto' || f.kind === 'stock' || f.kind === 'bond');
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
    const e0 = formError(f, supported, closed);
    if (e0) return setErr(e0);
    setBusy(true);
    setErr(null);
    try {
      if (edit) {
        await api.patch(`/api/tma/holdings/${holdingId}`, buildBody(f, { original: original!, supported, locked }));
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

  const toggleHidden = async (hidden: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/holdings/${holdingId}`, { hidden });
      nav.flash(hidden ? 'Позиция скрыта из списка' : 'Позиция снова в списке');
      nav.back();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
      setBusy(false);
    }
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
          {!usesQty(f.kind) && (
            <Field label="Валюта">
              <CcySelect value={f.currency} onChange={(v) => set('currency', v)} />
            </Field>
          )}

          {(f.kind === 'stock' || f.kind === 'bond') && (
            <MoexSearch
              api={api}
              kind={f.kind}
              enabled={autoEnabled}
              onPick={(it) => setF((s) => ({ ...s, ticker: it.secid, currency: it.currency, name: s.name.trim() ? s.name : it.name }))}
            />
          )}
          {closed && item ? (
            <div class="mb-3 rounded-2xl border border-line bg-zinc-900/60 p-3">
              <p class="text-[15px] text-zinc-100">
                Закрыта {fmtDay(item.closed_on!)}
                {item.realized_minor !== null && (
                  <span class={resultCls(item.realized_minor)}> · результат {resultText(item.realized_minor, item.currency)}</span>
                )}
              </p>
              <p class={`${mutedCls} mt-1`}>Позиция продана целиком. Купите ещё — она снова откроется.</p>
            </div>
          ) : locked && item ? (
            <>
              <div class={swapCls}>
                <span class={swapLabelCls}>Потрачено</span>
                <p class="text-[24px] font-medium text-zinc-100">
                  {item.invested ?? '—'} {item.currency}
                </p>
              </div>
              <div class={swapCls}>
                <span class={swapLabelCls}>Количество</span>
                <p class="text-[24px] font-medium text-zinc-100">
                  {item.quantity ?? '—'} {item.ticker ?? ''}
                </p>
                {item.avg_cost && (
                  <p class="text-[12px] text-zinc-500">
                    Средняя цена покупки: {item.avg_cost} {item.currency}
                  </p>
                )}
              </div>
              <p class={`${mutedCls} mb-3`}>Количество, сумма и валюта меняются через сделки.</p>
              <Field label="Тикер">
                <TickerField kind={f.kind} value={f.ticker} supported={supported} onChange={(v) => set('ticker', v)} />
              </Field>
              {needsPrice(f, supported) && <Field label="Цена сейчас (за единицу)">{txt('price', { inputMode: 'decimal', placeholder: '30000' })}</Field>}
            </>
          ) : usesQty(f.kind) ? (
            <>
              {/* как в обменниках: сумма и её валюта/тикер в одной строке */}
              <div class={swapCls}>
                <span class={swapLabelCls}>Потратил</span>
                <div class="flex items-center gap-3">
                  <input
                    class={swapInputCls}
                    value={f.invested}
                    inputMode="decimal"
                    placeholder="0"
                    onInput={(e) => set('invested', (e.target as HTMLInputElement).value)}
                  />
                  <div class="w-28 shrink-0">
                    <CcySelect value={f.currency} onChange={(v) => set('currency', v)} />
                  </div>
                </div>
              </div>
              <div class={swapCls}>
                <span class={swapLabelCls}>Получил</span>
                <div class="flex items-center gap-3">
                  <input
                    class={swapInputCls}
                    value={f.quantity}
                    inputMode="decimal"
                    placeholder="0"
                    onInput={(e) => set('quantity', (e.target as HTMLInputElement).value)}
                  />
                  <div class="w-28 shrink-0">
                    <TickerField kind={f.kind} value={f.ticker} supported={supported} onChange={(v) => set('ticker', v)} />
                  </div>
                </div>
              </div>
              <p class={`${mutedCls} mb-3`}>
                Сколько заплатили всего и сколько единиц получили.{' '}
                {f.kind === 'stock' || f.kind === 'bond' ? 'Количество — в штуках, не в лотах. ' : ''}Цену за штуку считаем сами.
              </p>
              {needsPrice(f, supported) ? (
                <Field label="Цена сейчас (за единицу)">{txt('price', { inputMode: 'decimal', placeholder: '30000' })}</Field>
              ) : (
                <p class={`${mutedCls} mb-3`}>
                  {f.kind === 'crypto'
                    ? 'Цену этой монеты приложение берёт само.'
                    : `Цену бумаги берём с Мосбиржи${f.kind === 'bond' ? ' (с НКД)' : ''}; если биржа не ответит — оценим по сумме покупки.`}
                </p>
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
      {tradable && item && <TradesBlock api={api} nav={nav} item={item} onChanged={onChanged} />}
      {closed && item && (
        <div class="mt-4">
          <button type="button" class={`${smBtnCls} w-full justify-center`} disabled={busy} onClick={() => void toggleHidden(!item.hidden)}>
            {item.hidden ? 'Показывать в списке' : 'Скрыть из списка'}
          </button>
        </div>
      )}
      {edit && (
        <div class="mt-4">
          {confirmDel ? (
            <div class="flex gap-2">
              <button type="button" class={`${dangerBtnCls} flex-1`} disabled={busy} onClick={() => void del()}>
                {item && item.trades_count > 0 ? `Удалить вместе с ${item.trades_count} сделками?` : 'Точно удалить?'}
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
  const autoEnabled = !!q.data?.auto.enabled;
  if (holdingId !== undefined && !item) {
    return <ErrorView title="Позиция не найдена" text="Возможно, она уже удалена." onRetry={() => nav.back()} />;
  }
  return (
    <HoldingFormView
      key={item ? `${item.trades_count}:${item.quantity}:${item.closed_on}:${item.hidden}` : 'new'}
      api={api}
      nav={nav}
      original={item ? fromItem(item) : null}
      supported={supported}
      autoEnabled={autoEnabled}
      item={item ?? null}
      onChanged={q.reload}
      {...(holdingId !== undefined ? { holdingId } : {})}
    />
  );
}
