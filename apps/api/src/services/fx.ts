/**
 * services/fx.ts — валютный анализ и алерты (шаг 8).
 *
 * Порт связки FXAnalytics.gs: пары конвертации строятся из профиля
 * (доход → повседневные / база / каждая валюта активных кредитов), история —
 * один запрос Frankfurter на пару (прямой base=from, иначе кросс через USD),
 * статистика — чистый domain/fx.ts. Кэша анализа нет: считается по запросу.
 *
 * Алерты (cron, см. runReminders): перцентиль ≥ 85 → «выгодное окно»,
 * ≤ 15 → «нижняя зона», кулдаун — одна ISO-неделя на пару и тип через
 * claimReminder('fx', '<key>:<kind>:<isoWeek>').
 */
import { cross_, makeAction_, type FxAction, type FxPoint } from '../domain/fx';
import { isoWeek } from '../domain/dates';
import type { FxHistory, FxProvider } from '../fx/provider';
import { FxUnavailable } from '../fx/provider';
import type { ExchangeRow, ProfileRow, ScopedRepo } from '../db/repo';
import { fmtMoney, fmtPct } from '../bot/format';
import { todayInTz } from '../bot/parse';
import type { ReplyMarkup } from '../telegram/client';

/** Глубина истории — как в v1 (GOOGLEFINANCE TODAY()-180). */
export const FX_HISTORY_DAYS = 180;
/** Пороги алертов — CONFIG.FX_ALERTS из Config.gs. */
export const FX_ALERT_HIGH = 85;
export const FX_ALERT_LOW = 15;
export const FX_DISCLAIMER =
  'Статистическая модель (перцентиль + тренд + волатильность). Не является инвестиционной рекомендацией.';
const MAX_PAIRS = 6;

// ── пары конвертации ──

export interface FxPairDef {
  /** 'eur_rub' — ключ кулдауна алертов (нижний регистр, как в v1). */
  key: string;
  from: string;
  to: string;
  /** 'EUR → RUB' — подпись карточки. */
  label: string;
  purpose: string;
  emoji: string;
  /** v1 слал алерты только по eur_rub/eur_kgs; «база/инвестиции» — без пушей. */
  alerts: boolean;
}

/**
 * Пары по умолчанию из профиля: income → living (повседневные), income → base
 * (база учёта/инвестиции), income → каждая валюта активных долгов.
 * Дубли и самопары отбрасываются, максимум MAX_PAIRS.
 */
export function fxPairDefs(p: ProfileRow, debtCurrencies: string[]): FxPairDef[] {
  const from = p.income_currency.toUpperCase();
  const out: FxPairDef[] = [];
  const seen = new Set<string>();
  const push = (to: string, purpose: string, emoji: string, alerts: boolean) => {
    const t = to.toUpperCase();
    if (t === from || seen.has(t) || out.length >= MAX_PAIRS) return;
    seen.add(t);
    out.push({
      key: `${from}_${t}`.toLowerCase(),
      from,
      to: t,
      label: `${from} → ${t}`,
      purpose,
      emoji,
      alerts,
    });
  };
  push(p.living_currency, 'повседневные', '🛒', true);
  push(p.base_currency, 'инвестиции и база учёта', '📈', false);
  for (const c of debtCurrencies) push(c, 'платежи по кредитам', '🏦', true);
  return out;
}

// ── история ──

export type FxHistoryGet = (base: string, quotes: string[], from: string, to: string) => Promise<FxHistory>;

/** Провайдер → единый геттер истории; без history — всегда FxUnavailable. */
export function histOf(provider: FxProvider): FxHistoryGet {
  return (base, quotes, from, to) => {
    if (!provider.history) return Promise.reject(new FxUnavailable('Провайдер не отдаёт историю курсов'));
    return provider.history(base, quotes, from, to);
  };
}

/**
 * Серия пары: прямой запрос from→to; если точек < 30 и обе валюты не USD —
 * кросс через USD (from→USD × USD→to по совпадающим датам, как v1 EUR×USDKGS).
 * null → пара пропускается (мало данных / провайдер молчит).
 */
async function loadSeries(hist: FxHistoryGet, from: string, to: string, dFrom: string, dTo: string): Promise<FxPoint[] | null> {
  try {
    const h = await hist(from, [to], dFrom, dTo);
    const s = h[to];
    if (s && s.length >= 30) return s;
  } catch {
    /* провайдер/пара недоступны — пробуем кросс */
  }
  if (from === 'USD' || to === 'USD') return null; // кросс через USD бессмысленен
  try {
    const [a, b] = await Promise.all([hist(from, ['USD'], dFrom, dTo), hist('USD', [to], dFrom, dTo)]);
    const s1 = a['USD'];
    const s2 = b[to];
    if (!s1?.length || !s2?.length) return null;
    const c = cross_(s1, s2);
    return c.length >= 30 ? c : null;
  } catch {
    return null;
  }
}

// ── анализ ──

export interface FxAnalysis {
  ok: boolean;
  note?: string;
  generated_at: string;
  actions: FxAction[];
  skipped: string[];
  disclaimer: string;
}

/** 'YYYY-MM-DD HH:MM' в таймзоне пользователя (nowTz_ из v1). */
export function localStamp(tz: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return now.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Один прогон анализа: одна история на пару (не по дню), пара со слипшейся
 * историей (<30 точек / недоступна) уходит в skipped, а не роняет остальные.
 */
export async function buildAnalysis(
  hist: FxHistoryGet,
  pairs: FxPairDef[],
  now: Date,
  generatedAt?: string,
): Promise<FxAnalysis> {
  const dTo = now.toISOString().slice(0, 10);
  const dFrom = new Date(now.getTime() - FX_HISTORY_DAYS * 86400_000).toISOString().slice(0, 10);
  const actions: FxAction[] = [];
  const skipped: string[] = [];
  for (const pair of pairs) {
    const series = await loadSeries(hist, pair.from, pair.to, dFrom, dTo);
    const act = series ? makeAction_(series, pair.key, pair.label, pair.purpose, pair.emoji) : null;
    if (act) actions.push(act);
    else skipped.push(pair.label);
  }
  const note = actions.length
    ? skipped.length
      ? `Нет данных: ${skipped.join(', ')}`
      : undefined
    : 'Нет данных по валютным парам — история курсов недоступна.';
  return {
    ok: actions.length > 0,
    ...(note !== undefined ? { note } : {}),
    generated_at: generatedAt ?? now.toISOString().slice(0, 16).replace('T', ' '),
    actions,
    skipped,
    disclaimer: FX_DISCLAIMER,
  };
}

/** Порт renderText из FXAnalytics.gs (валюта курса — вторая часть label). */
export function renderFxText(a: FxAnalysis): string {
  if (!a.ok) return '💱 ' + (a.note ?? 'Нет данных по валютным парам.');
  const L = ['💱 <b>Валютный анализ</b> · ' + a.generated_at];
  for (const x of a.actions) {
    const arrow = x.change30d_pct >= 0 ? '▲' : '▼';
    const ccy = x.label.split('→')[1]?.trim() ?? 'USD';
    L.push(`${x.emoji} <b>${x.label}</b> (${x.purpose}): <b>${fmtMoney(x.current, ccy)}</b>`);
    L.push(
      `     ${arrow} ${x.change30d_pct >= 0 ? '+' : ''}${fmtPct(x.change30d_pct / 100)} за 30д` +
        ` · ${x.percentile}-й перцентиль · RSI ${x.rsi14} · тренд ${x.trend_up ? 'вверх' : 'вниз'}`,
    );
    L.push(`     ➜ <b>${x.signal_text}</b>`);
    L.push(
      `     Прогноз 30д: ${x.forecast30d.low} – ${x.forecast30d.high} (±σ, модель)` +
        (x.signal === 'split' ? ' — вторую половину меняйте по графику' : ''),
    );
  }
  if (a.skipped.length) L.push(`ℹ️ Нет данных: ${a.skipped.join(', ')}`);
  L.push('');
  L.push('⚠️ ' + a.disclaimer);
  L.push('ℹ️ Регулярные платежи (кредиты, аренда к дате) конвертируйте в срок — тайминг вторичен.');
  return L.join('\n');
}

// ── контекст экранов бота ──

export interface FxCtx {
  profile: ProfileRow;
  today: string;
  exchanges: ExchangeRow[];
  analysis: FxAnalysis;
  /** Валюты быстрых кнопок мастера: профиль + валюты активных кредитов. */
  ccys: string[];
}

/** repo → всё, что нужно экранам /fx: анализ + журнал обменов (один прогон). */
export async function buildFxCtx(
  repo: ScopedRepo,
  profile: ProfileRow,
  provider: FxProvider,
  now: Date,
): Promise<FxCtx> {
  const [ex, debts] = await Promise.all([repo.listExchanges(50), repo.listDebts()]);
  const debtCcys = debts.results.map((d) => d.currency);
  const pairs = fxPairDefs(profile, debtCcys);
  const analysis = await buildAnalysis(histOf(provider), pairs, now, localStamp(profile.timezone, now));
  const ccys = [...new Set([profile.income_currency, profile.living_currency, profile.base_currency, ...debtCcys])];
  return { profile, today: todayInTz(profile.timezone, now), exchanges: ex.results, analysis, ccys };
}

// ── алерты ──

/** Ключ ISO-недели для кулдауна: '2026-W43'. */
export function isoWeekKey(now: Date): string {
  const w = isoWeek(now.toISOString().slice(0, 10));
  return `${w.year}-W${String(w.week).padStart(2, '0')}`;
}

const ALERT_MARKUP: ReplyMarkup = {
  inline_keyboard: [
    [{ text: '💱 Курсы', callback_data: 'nv:go:FX_HUB' }],
    [{ text: '🏠 Меню', callback_data: 'nv:home' }],
  ],
};

/**
 * Push-алерты — порт checkAlerts: по уже посчитанному анализу (история
 * запрашивается ОДИН раз на пользователя за прогон — его делает вызывающий
 * через buildAnalysis). Возвращает отправленные '<key>:<kind>'.
 * Ошибки send пробрасываются: вызывающий сам решает 403/ретрай.
 */
export async function checkFxAlerts(
  repo: ScopedRepo,
  analysis: FxAnalysis,
  pairs: FxPairDef[],
  send: (text: string, markup?: ReplyMarkup) => Promise<void>,
  now: Date,
): Promise<string[]> {
  if (!analysis.ok) return [];
  const week = isoWeekKey(now);
  const alertKeys = new Set(pairs.filter((p) => p.alerts).map((p) => p.key));
  const sent: string[] = [];
  for (const x of analysis.actions) {
    if (!alertKeys.has(x.key)) continue; // v1: eur_usd/«база» — без пушей
    const kind = x.percentile >= FX_ALERT_HIGH ? 'hi' : x.percentile <= FX_ALERT_LOW ? 'lo' : null;
    if (!kind) continue;
    // Кулдаун ISO-неделя на пару и тип — повторный тик не шлёт повтор.
    const claimKey = `${x.key}:${kind}:${week}`;
    const claim = await repo.claimReminder('fx', claimKey);
    if (claim.meta.changes !== 1) continue;
    const ccy = x.label.split('→')[1]?.trim() ?? 'USD';
    const text =
      kind === 'hi'
        ? `🟢 <b>Выгодное окно конвертации ${x.emoji} ${x.label}</b>\n` +
          `Курс ${fmtMoney(x.current, ccy)} — ${x.percentile}-й перцентиль за ${FX_HISTORY_DAYS} дней (RSI ${x.rsi14}).\n` +
          `Хороший момент обменять ${x.label.split('→')[0]!.trim()} на ${ccy} (${x.purpose}).\n\n` +
          `${x.signal_text}\n/fx — детали`
        : `🔴 <b>Курс ${x.emoji} ${x.label} в нижней зоне</b>\n` +
          `Перцентиль ${x.percentile}/100 — по возможности отложите конвертацию ` +
          `(кроме регулярных платежей).\n/fx — детали`;
    try {
      await send(text, ALERT_MARKUP);
    } catch (e) {
      // сбой отправки — снимаем claim: следующий часовой тик окна повторит
      await repo.releaseReminder('fx', claimKey);
      throw e;
    }
    sent.push(`${x.key}:${kind}`);
  }
  return sent;
}

/**
 * Полный прогон алертов пользователя из cron: флаг выключен → молча.
 * Пары + анализ (один запрос истории на пару) + рассылка с кулдауном.
 */
export async function runFxAlerts(
  repo: ScopedRepo,
  profile: ProfileRow,
  provider: FxProvider,
  send: (text: string, markup?: ReplyMarkup) => Promise<void>,
  now: Date,
): Promise<string[]> {
  if (profile.fx_alerts_enabled !== 1) return [];
  const debts = await repo.listDebts();
  const pairs = fxPairDefs(profile, debts.results.map((d) => d.currency));
  if (!pairs.length) return [];
  const analysis = await buildAnalysis(histOf(provider), pairs, now, localStamp(profile.timezone, now));
  return checkFxAlerts(repo, analysis, pairs, send, now);
}
