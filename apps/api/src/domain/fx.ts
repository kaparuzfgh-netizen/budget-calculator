/**
 * domain/fx.ts — статистика валютных серий. Порт apps-script/FXAnalytics.gs
 * ОДИН-В-ОДИН (имена с подчёркиванием сохранены, чтобы дифф с v1 читался
 * построчно). Чистые функции, без I/O.
 *
 * Серия — [{date:'YYYY-MM-DD', v:число}] дневных закрытий (180 дней).
 * Для конвертации A→B «высокий курс» = выгодно продавать A за B:
 *   перцентиль ≥ 70 → конвертировать; 45–69 → дробить 50/50;
 *   30–44 → отложить; < 30 → отложить (кроме регулярных платежей).
 */

export interface FxPoint {
  date: string;
  v: number;
}

export interface FxForecast {
  low: number;
  mid: number;
  high: number;
}

export interface FxStats {
  current: number;
  digits: number;
  min: number;
  max: number;
  percentile: number;
  z180: number;
  move30: number;
  band30: number;
  sma20: number;
  sma50: number;
  trendUp: boolean;
  change30dPct: number;
  rsi14: number;
  vol30dPct: number;
  forecast7d: FxForecast;
  forecast30d: FxForecast;
  series: number[];
}

export type FxSignalKind = 'convert' | 'split' | 'wait' | 'hold';

export interface FxSignal {
  signal: FxSignalKind;
  text: string;
}

export interface FxAction {
  key: string;
  label: string;
  purpose: string;
  emoji: string;
  current: number;
  digits: number;
  min: number;
  max: number;
  percentile: number;
  rsi14: number;
  change30d_pct: number;
  vol30d_pct: number;
  trend_up: boolean;
  signal: FxSignalKind;
  signal_text: string;
  forecast7d: FxForecast;
  forecast30d: FxForecast;
  series: number[];
}

/** Кросс-курс a×b по совпадающим датам (напр. EURKGS = EURUSD × USDKGS). */
export function cross_(a: FxPoint[], b: FxPoint[]): FxPoint[] {
  const mapB = new Map<string, number>();
  for (const x of b) mapB.set(x.date, x.v);
  const out: FxPoint[] = [];
  for (const x of a) {
    const bv = mapB.get(x.date);
    if (bv !== undefined) out.push({ date: x.date, v: x.v * bv });
  }
  return out;
}

export function mean_(a: number[]): number {
  return a.reduce((s, x) => s + x, 0) / a.length;
}

/** Выборочная σ (деление на n−1), как в v1. */
export function std_(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean_(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

export function sma_(closes: number[], n: number): number {
  return mean_(closes.slice(-Math.min(n, closes.length)));
}

/** RSI(14), простое усреднение за последние period диффов (НЕ Wilder). */
export function rsi_(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

/** Наклон линейной регрессии за последние n точек, в относительном выражении/день. */
export function slopeRel_(closes: number[], n: number): number {
  const win = closes.slice(-Math.min(n, closes.length));
  const len = win.length;
  if (len < 3) return 0;
  const cur = win[len - 1]!;
  let sx = 0,
    sy = 0,
    sxy = 0,
    sxx = 0;
  for (let i = 0; i < len; i++) {
    sx += i;
    sy += win[i]!;
    sxy += i * win[i]!;
    sxx += i * i;
  }
  const denom = len * sxx - sx * sx;
  if (denom === 0 || cur === 0) return 0;
  return (len * sxy - sx * sy) / denom / cur;
}

/** Прогноз: середина = тренд, границы = ±σ√h (σ — дневная доходность за 30д). */
export function forecast_(closes: number[], horizonDays: number): FxForecast {
  const cur = closes[closes.length - 1]!;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! / closes[i - 1]! - 1);
  const sigma = std_(rets.slice(-30));
  const slope = slopeRel_(closes, 30);
  const h = horizonDays;
  const mid = cur * (1 + slope * h);
  const band = sigma * Math.sqrt(h);
  return {
    low: Math.round(cur * (1 + slope * h - band) * 1e4) / 1e4,
    mid: Math.round(mid * 1e4) / 1e4,
    high: Math.round(cur * (1 + slope * h + band) * 1e4) / 1e4,
  };
}

/** Полный набор статистик серии; < 30 точек → null (пара пропускается). */
export function stats_(series: FxPoint[]): FxStats | null {
  const closes = series.map((x) => x.v);
  const n = closes.length;
  if (n < 30) return null;
  const cur = closes[n - 1]!;
  const sorted = closes.slice().sort((a, b) => a - b);
  const percentile = Math.round((100 * sorted.filter((v) => v <= cur).length) / n);
  const mean180 = mean_(closes);
  const std180 = std_(closes);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! / closes[i - 1]! - 1);
  const sigma = std_(rets.slice(-30));
  const slope30 = slopeRel_(closes, 30);
  const band30 = sigma * Math.sqrt(30);
  return {
    current: cur,
    digits: cur > 20 ? 2 : 4,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    percentile,
    z180: std180 > 0 ? (cur - mean180) / std180 : 0,
    move30: slope30 * 30, // ожидаемое смещение за 30д по тренду
    band30, // собственный шум за 30д (±σ)
    sma20: mean_(closes.slice(-20)),
    sma50: mean_(closes.slice(-50)),
    trendUp: sma_(closes, 20) > sma_(closes, 50),
    change30dPct: n > 30 ? cur / closes[n - 31]! - 1 : 0,
    rsi14: Math.round(rsi_(closes, 14)),
    vol30dPct: Math.round(sigma * Math.sqrt(30) * 10000) / 100,
    forecast7d: forecast_(closes, 7),
    forecast30d: forecast_(closes, 30),
    series: closes.slice(-90),
  };
}

/** Рекомендация: высокий курс = выгодно продавать «from» за «to». */
export function signal_(st: {
  z180: number;
  band30: number;
  move30: number;
  percentile: number;
  rsi14: number;
}): FxSignal {
  // боковик: тренд за 30д тише собственного шума, курс у среднего —
  // тайминг не имеет смысла, всегда нейтрально
  const sideways = Math.abs(st.z180) < 0.5 || (st.band30 > 0 && Math.abs(st.move30) < 0.5 * st.band30);
  if (sideways) return { signal: 'split', text: 'Нейтрально (боковик) — меняйте частями 50/50' };
  let score = st.percentile;
  if (st.rsi14 >= 65) score += 5; // сильный импульс вверх
  if (st.rsi14 <= 35) score -= 5; // перепроданность — вероятен откат вверх
  if (score >= 70) return { signal: 'convert', text: 'Курс высокий — конвертируйте сейчас' };
  if (score >= 45) return { signal: 'split', text: 'Нейтрально — меняйте частями 50/50' };
  if (score >= 30) return { signal: 'wait', text: 'Ниже среднего — по возможности отложите' };
  return { signal: 'hold', text: 'Низкий диапазон — отложите (кроме регулярных платежей)' };
}

/** stats_ + signal_ + метаданные пары → карточка; < 30 точек → null. */
export function makeAction_(series: FxPoint[], key: string, label: string, purpose: string, emoji: string): FxAction | null {
  const st = stats_(series);
  if (!st) return null;
  const sig = signal_(st);
  return {
    key,
    label,
    purpose,
    emoji,
    current: st.current,
    digits: st.digits,
    min: st.min,
    max: st.max,
    percentile: st.percentile,
    rsi14: st.rsi14,
    change30d_pct: Math.round(st.change30dPct * 1000) / 10,
    vol30d_pct: st.vol30dPct,
    trend_up: st.trendUp,
    signal: sig.signal,
    signal_text: sig.text,
    forecast7d: st.forecast7d,
    forecast30d: st.forecast30d,
    series: st.series,
  };
}
