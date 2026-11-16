import { useState } from 'preact/hooks';
import { Users } from 'lucide-preact';
import { ApiError } from '../api';
import type { Api, HouseholdInviteResponse, HouseholdSummary } from '../api';
import type { Nav } from '../app';
import { amountError, currencyError, fmtMinor, parseAmount } from '../fmt';
import { cardCls, Field, FormError, inputCls, mutedCls, primaryBtnCls, rowCls, secondaryBtnCls, smBtnCls } from '../ui';

// ── Семья: общий бюджет пары ──

export function FamilyCard({
  api,
  nav,
  pair,
  reload,
}: {
  api: Api;
  nav: Nav;
  pair: HouseholdSummary | null;
  reload: () => void;
}) {
  const [cap, setCap] = useState(String((pair?.living_cap_minor ?? 0) / 100 || ''));
  const [ccy, setCcy] = useState(pair?.currency ?? 'USD');
  const [joinCode, setJoinCode] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Не удалось — проверьте соединение');

  const createInvite = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<HouseholdInviteResponse>('/api/tma/household/invite');
      setInvite(r.link ?? r.code);
      nav.flash('Приглашение создано — отправьте ссылку партнёру');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const join = async (ev: Event) => {
    ev.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/household/join', { code: joinCode });
      nav.flash('Вы в общем бюджете');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const saveCap = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(cap);
    const cErr = currencyError(ccy);
    if (aErr || cErr) return setErr(aErr ?? cErr);
    setBusy(true);
    setErr(null);
    try {
      await api.patch('/api/tma/household', { living_cap: parseAmount(cap), living_currency: ccy.trim().toUpperCase() });
      nav.flash('Общий лимит сохранён');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const leave = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/household/leave');
      nav.flash('Вы вышли из общего бюджета');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!pair) {
    return (
      <div class={`${cardCls} mt-2`}>
        <p class={`${mutedCls} mb-3`}>
          Общий недельный бюджет на двоих. Создайте пару — партнёр присоединится по ссылке —
          или введите код приглашения от партнёра.
        </p>
        {invite ? (
          <div class={`${cardCls} bg-fill/40 mb-3 break-all text-[13px]`}>
            <p class={mutedCls}>Передайте партнёру (одноразовая, 48 ч):</p>
            <p class="mt-1 font-mono text-sky-400">{invite}</p>
          </div>
        ) : (
          <button type="button" class={primaryBtnCls} disabled={busy} onClick={() => void createInvite()}>
            <Users size={16} strokeWidth={1.5} /> Создать общий бюджет
          </button>
        )}
        <form class="mt-3 flex gap-2" onSubmit={(e) => void join(e)}>
          <input
            class={`${inputCls} flex-1`}
            placeholder="Код приглашения или ссылка"
            value={joinCode}
            onInput={(e) => setJoinCode((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class={smBtnCls} disabled={busy || !joinCode.trim()}>
            Вступить
          </button>
        </form>
        <FormError msg={err} />
      </div>
    );
  }

  return (
    <div class={`${cardCls} mt-2`}>
      {pair.members.map((m) => (
        <div key={m.user_id} class={rowCls}>
          <span>{m.is_me ? 'Вы' : (m.name ?? 'Партнёр')}</span>
          <span class={mutedCls}>
            {fmtMinor(m.spent_week_minor, pair.currency)} за неделю{m.role === 'owner' ? ' · создатель' : ''}
          </span>
        </div>
      ))}
      <form class="mt-4" onSubmit={(e) => void saveCap(e)}>
        <Field label="Месячный лимит пары">
          <div class="flex gap-2">
            <input
              class={`${inputCls} flex-1`}
              inputMode="decimal"
              value={cap}
              onInput={(e) => setCap((e.target as HTMLInputElement).value)}
            />
            <input
              class={`${inputCls} w-20`}
              maxLength={5}
              value={ccy}
              onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
            />
          </div>
        </Field>
        <button type="submit" class={`${primaryBtnCls} mt-3`} disabled={busy}>
          Сохранить лимит
        </button>
      </form>
      <button type="button" class={`${secondaryBtnCls} mt-2 text-red-400`} disabled={busy} onClick={() => void leave()}>
        Выйти из общего бюджета
      </button>
      <FormError msg={err} />
    </div>
  );
}
