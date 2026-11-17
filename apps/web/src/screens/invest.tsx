/**
 * invest.tsx — «Инвестиции» в Mini App (T3a, ручной портфель).
 *
 * GET /api/tma/holdings: итог в валюте бюджета, доли по видам vs цели,
 * список позиций (тап → правка). Цели распределения — PATCH /api/tma/profile
 * {invest_targets}; по ним делится часть бонуса «в DCA» в «Плане».
 * Позиция без курса видна, но в итог не входит (пометка «нет курса»).
 * Это учёт, а не инвестиционная рекомендация.
 */
import { useState } from 'preact/hooks';
import { Briefcase, Plus, Target, TriangleAlert } from 'lucide-preact';
import { ApiError } from '../api';
import type { HoldingItem, HoldingKind, HoldingsList } from '../api';
import type { ScreenProps } from '../app';
import { fmtDay, fmtMinor } from '../fmt';
import {
  cardCls,
  ErrorView,
  errorView,
  FormError,
  headCls,
  inputCls,
  liCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowCls,
  smBtnCls,
  useData,
} from '../ui';
import { fmtAutoTime, KIND_LABEL, KIND_PLURAL, KINDS, targetsFrom } from './invest-common';

function Position({ h, onOpen }: { h: HoldingItem; onOpen: () => void }) {
  const qty = !!h.quantity;
  const badge =
    h.price_source === 'auto'
      ? `авто · ${fmtAutoTime(h.effective_price_at)}`
      : h.valued_at_cost
        ? 'по цене покупки'
        : h.auto_note === 'ccy_unsupported'
          ? `нет автоцены в ${h.currency} · вручную`
          : h.price_on && h.effective_price
            ? `вручную · ${fmtDay(h.price_on)}`
            : null;
  return (
    <li class={`${liCls} cursor-pointer transition hover:bg-fill`} onClick={onOpen}>
      <div class={rowCls}>
        <span class="text-[15px] text-zinc-100">
          {h.name}
          {h.ticker ? <span class="text-zinc-500"> · {h.ticker}</span> : ''}
        </span>
        <span>{fmtMinor(h.value_minor, h.currency)}</span>
      </div>
      <div class={`${rowCls} mt-1`}>
        <span class={mutedCls}>
          {KIND_LABEL[h.kind]}
          {qty ? ` · ${h.quantity}${h.ticker ? ` ${h.ticker}` : ''}` : ''}
          {qty && h.invested ? ` · потрачено ${h.invested} ${h.currency}` : ''}
          {h.rate !== null && h.kind === 'deposit' ? ` · ${h.rate}%` : ''}
        </span>
        {h.pnl_minor !== null ? (
          <span class={`text-[13px] ${h.pnl_minor >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {h.pnl_minor >= 0 ? '+' : ''}
            {fmtMinor(h.pnl_minor, h.currency)}
          </span>
        ) : h.accrued_minor !== null ? (
          <span class={mutedCls}>≈ начислено {fmtMinor(h.accrued_minor, h.currency)}</span>
        ) : null}
      </div>
      {badge && <p class="mt-1 text-[12px] text-zinc-500">{badge}</p>}
      {h.price_stale && (
        <p class="mt-1 text-[12px] text-amber-400">
          {h.price_source === 'auto'
            ? `Автоцена устарела (${fmtAutoTime(h.effective_price_at)}) — провайдер недоступен`
            : `Цена на ${h.effective_price_on ? fmtDay(h.effective_price_on) : '—'} — обновите цену`}
        </p>
      )}
    </li>
  );
}

function Targets({
  api,
  current,
  onSaved,
}: {
  api: ScreenProps['api'];
  current: Partial<Record<HoldingKind, number>> | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<HoldingKind, string>>>(() =>
    Object.fromEntries(KINDS.filter((k) => current?.[k]).map((k) => [k, String(current![k])])),
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (clear: boolean) => {
    let body: Record<string, number> | null = null;
    if (!clear) {
      const r = targetsFrom(draft);
      if ('error' in r) return setErr(r.error);
      body = r.targets;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.patch<unknown>('/api/tma/profile', { invest_targets: body });
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    }
    setBusy(false);
    return undefined;
  };

  return (
    <>
      <h2 class={`${headCls} mt-6`}>
        <Target size={16} strokeWidth={1.5} /> Цели распределения
      </h2>
      <div class={`${cardCls} mt-2`}>
        {!open ? (
          <div class={rowCls}>
            <span class={mutedCls}>
              {current
                ? KINDS.filter((k) => current[k])
                    .map((k) => `${KIND_PLURAL[k].toLowerCase()} ${current[k]}%`)
                    .join(' · ')
                : 'Не заданы — часть бонуса «в DCA» остаётся в USD'}
            </span>
            <button type="button" class={smBtnCls} onClick={() => setOpen(true)}>
              {current ? 'Изменить' : 'Задать'}
            </button>
          </div>
        ) : (
          <>
            <p class={`${mutedCls} mb-3`}>Доли в процентах, сумма ровно 100. Пусто — 0%.</p>
            <div class="grid grid-cols-2 gap-x-3">
              {KINDS.map((k) => (
                <label class="mb-3 flex flex-col">
                  <span class="mb-1.5 text-[13px] text-zinc-400">{KIND_PLURAL[k]}, %</span>
                  <input
                    class={inputCls}
                    inputMode="numeric"
                    maxLength={3}
                    value={draft[k] ?? ''}
                    onInput={(e) => setDraft({ ...draft, [k]: (e.target as HTMLInputElement).value })}
                  />
                </label>
              ))}
            </div>
            <FormError msg={err} />
            <button type="button" class={primaryBtnCls} disabled={busy} onClick={() => void save(false)}>
              {busy ? 'Сохраняю…' : 'Сохранить цели'}
            </button>
            <div class="mt-2 flex gap-2">
              <button type="button" class={`${smBtnCls} flex-1 justify-center`} onClick={() => setOpen(false)}>
                Отмена
              </button>
              {current && (
                <button type="button" class={`${smBtnCls} flex-1 justify-center`} disabled={busy} onClick={() => void save(true)}>
                  Сбросить цели
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function InvestScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<HoldingsList>('/api/tma/holdings'), onFatal, []);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const d = q.data;
  const shares = KINDS.filter((k) => d.allocation.current[k]);

  return (
    <>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Briefcase size={20} strokeWidth={1.5} class="text-sky-400" /> Инвестиции
        </h1>
        <button type="button" class={smBtnCls} onClick={() => nav.push({ id: 'invest-form' })}>
          <Plus size={14} strokeWidth={1.5} /> Добавить
        </button>
      </div>

      <div class={cardCls}>
        <p class={mutedCls}>Итого в портфеле</p>
        <p class="mt-1 text-2xl font-semibold">
          {d.total.minor === null ? '—' : fmtMinor(d.total.minor, d.total.currency)}
        </p>
        {shares.length > 0 && (
          <p class={`${mutedCls} mt-2`}>
            {shares.map((k) => `${KIND_PLURAL[k].toLowerCase()} ${d.allocation.current[k]}%`).join(' · ')}
          </p>
        )}
        {d.total.minor === null && d.items.length > 0 && (
          <p class="mt-2 flex items-center gap-1.5 text-[13px] text-amber-400">
            <TriangleAlert size={14} strokeWidth={1.5} /> Курсы недоступны — сумма не посчитана
          </p>
        )}
        {d.total.missing_rates.length > 0 && (
          <p class="mt-2 flex items-center gap-1.5 text-[13px] text-amber-400">
            <TriangleAlert size={14} strokeWidth={1.5} /> Нет курса для {d.total.missing_rates.join(', ')} — позиции видны,
            но в итог не входят
          </p>
        )}
        {d.total.fx_stale && <p class="mt-2 text-[13px] text-amber-400">Курсы устарели — провайдер недоступен</p>}
      </div>

      <h2 class={`${headCls} mt-6`}>Позиции</h2>
      <div class={`${listCardCls} mt-2`}>
        {d.items.length ? (
          <ul class="divide-y divide-line-soft">
            {d.items.map((h) => (
              <Position h={h} onOpen={() => nav.push({ id: 'invest-form', holdingId: h.id })} />
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Пока пусто. Добавьте вклад, облигации, крипту или акции.</p>
        )}
      </div>

      <Targets api={api} current={d.allocation.targets} onSaved={q.reload} />

      <p class={`${mutedCls} mt-6`}>
        {d.disclaimer} {d.auto.enabled && d.auto.available ? 'Цены крипты — автоматические, остальное вручную.' : 'Цены вводятся вручную.'}
      </p>
      {d.auto.enabled && d.auto.available && d.items.some((h) => h.price_source === 'auto') && (
        <p class={`${mutedCls} mt-2`}>
          <a href={d.auto.attribution.url} target="_blank" rel="noopener noreferrer" class="text-sky-400 underline">
            {d.auto.attribution.text}
          </a>
        </p>
      )}
    </>
  );
}

