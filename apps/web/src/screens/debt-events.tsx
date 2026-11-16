import { useState } from 'preact/hooks';
import { Pencil, Shuffle, Trash2 } from 'lucide-preact';
import type { Api, DebtDetail, DebtEvent } from '../api';
import type { Nav } from '../app';
import { amountError, fmtDay, fmtMinor, parseAmount } from '../fmt';
import { confirmCls, dangerBtnCls, evEditCls, Field, FormError, inputCls, mutedCls, rowCls, smBtnCls, smDangerBtnCls, smDangerFillBtnCls, smGhostBtnCls } from '../ui';
import { EVENT_KIND, MODE_LABEL, apiErr } from './debt-common';

export function EventRow({
  api, ev, currency, open, onToggle, onDone,
}: {
  api: Api;
  ev: DebtEvent;
  currency: string;
  open: boolean;
  onToggle: () => void;
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState(String(ev.amount_minor / 100));
  const [on, setOn] = useState(ev.event_on);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const Kind = EVENT_KIND[ev.kind];

  const save = async (e: Event) => {
    e.preventDefault();
    const aErr = amountError(amount);
    if (aErr) return setErr(aErr);
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/debt-events/${ev.id}`, {
        amount: parseAmount(amount),
        event_on: on,
      });
      onDone('Событие обновлено — остаток пересчитан');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось сохранить'));
      setBusy(false);
    }
    return undefined;
  };
  const flipMode = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/debt-events/${ev.id}`, {
        mode: ev.mode === 'reduce_term' ? 'reduce_payment' : 'reduce_term',
      });
      onDone('Режим ЧДП переключён');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось переключить режим'));
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.del(`/api/tma/debt-events/${ev.id}`);
      onDone('Событие удалено — остаток пересчитан');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось удалить'));
      setBusy(false);
    }
  };

  return (
    <li class="px-4 py-3">
      <div class={`${rowCls} cursor-pointer`} onClick={onToggle}>
        <span class="flex items-center gap-1.5">
          <Kind.icon size={15} strokeWidth={1.5} class="text-zinc-500" /> {Kind.label}
          {ev.kind === 'prepay' && ev.mode ? <span class={mutedCls}> ({MODE_LABEL[ev.mode]})</span> : ''}
        </span>
        <span class={open ? 'text-sky-300' : ''}>
          {fmtDay(ev.event_on)} · {fmtMinor(ev.amount_minor, currency)}
        </span>
      </div>
      {open && (
        <div class={evEditCls}>
          <form onSubmit={(e) => void save(e)}>
            <div class="flex gap-3">
              <Field label="Сумма">
                <input class={inputCls} inputMode="decimal" value={amount}
                  onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Дата">
                <input class={inputCls} type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <FormError msg={err} />
            <div class="flex gap-2">
              <button type="submit" class={`${smBtnCls} flex-1 justify-center`} disabled={busy}>
                <Pencil size={13} strokeWidth={1.5} /> Сохранить
              </button>
              {ev.kind === 'prepay' && (
                <button type="button" class={`${smBtnCls} flex-1 justify-center`} disabled={busy} onClick={() => void flipMode()}>
                  <Shuffle size={13} strokeWidth={1.5} /> Режим
                </button>
              )}
              {confirmDel ? (
                <>
                  <button type="button" class={`${smDangerBtnCls} flex-1 justify-center`} disabled={busy} onClick={() => void del()}>
                    Точно удалить?
                  </button>
                  <button type="button" class={smBtnCls} onClick={() => setConfirmDel(false)}>Нет</button>
                </>
              ) : (
                <button type="button" class={smDangerBtnCls} disabled={busy} onClick={() => setConfirmDel(true)}>
                  <Trash2 size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </li>
  );
}

export function DeleteDebt({ api, nav, debt }: { api: Api; nav: Nav; debt: DebtDetail }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/debts/${debt.id}`);
      nav.flash('Кредит удалён');
      nav.back();
    } catch (e) {
      setErr(apiErr(e, 'Не удалось удалить'));
      setBusy(false);
    }
  };
  return confirm ? (
    <div class={`${confirmCls} mt-3`}>
      <p class="text-sm">Удалить «{debt.name}» вместе с журналом? Действие необратимо.</p>
      <div class="mt-2 flex gap-2">
        <button type="button" class={smDangerFillBtnCls} disabled={busy} onClick={() => void del()}>Да, удалить</button>
        <button type="button" class={smGhostBtnCls} onClick={() => setConfirm(false)}>Отмена</button>
      </div>
      <FormError msg={err} />
    </div>
  ) : (
    <button type="button" class={`${dangerBtnCls} mt-3`} onClick={() => setConfirm(true)}>
      <Trash2 size={16} strokeWidth={1.5} /> Удалить кредит
    </button>
  );
}

// ── мастер добавления ──
