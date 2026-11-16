
/** Плавная кривая без перелётов: монотонная кубика Фрича–Карлсона. */
function smoothPath(px: number[], py: number[]): string {
  const n = px.length;
  if (n < 2) return `M${(px[0] ?? 0).toFixed(1)},${(py[0] ?? 0).toFixed(1)}`;
  const dx: number[] = [];
  const sl: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(px[i + 1]! - px[i]!);
    sl.push((py[i + 1]! - py[i]!) / dx[i]!);
  }
  const t: number[] = [sl[0]!];
  for (let i = 1; i < n - 1; i++) {
    const s0 = sl[i - 1]!;
    const s1 = sl[i]!;
    t.push(s0 * s1 <= 0 ? 0 : (s0 + s1) / 2);
  }
  t.push(sl[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / sl[i]!;
    const b = t[i + 1]! / sl[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * sl[i]!;
      t[i + 1] = k * b * sl[i]!;
    }
  }
  let d = `M${px[0]!.toFixed(1)},${py[0]!.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${(px[i]! + h).toFixed(1)},${(py[i]! + t[i]! * h).toFixed(1)} ${(px[i + 1]! - h).toFixed(1)},${(py[i + 1]! - t[i + 1]! * h).toFixed(1)} ${px[i + 1]!.toFixed(1)},${py[i + 1]!.toFixed(1)}`;
  }
  return d;
}

/** «Температура» темпа: rate (× к идеалу) → RGB. Холодно (мало тратим) —
 * почти белый; в графике — изумруд; теплее — янтарь; перегрев — красный. */
function paceRGB(rate: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [244, 244, 245]],
    [0.6, [52, 211, 153]],
    [1.0, [52, 211, 153]],
    [1.15, [251, 191, 36]],
    [1.45, [248, 113, 113]],
    [1.9, [220, 38, 38]],
  ];
  if (rate <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [r1, c1] = stops[i - 1]!;
    const [r2, c2] = stops[i]!;
    if (rate <= r2) {
      const k = (rate - r1) / (r2 - r1);
      return c1.map((v, j) => Math.round(v + (c2[j]! - v) * k)) as [number, number, number];
    }
  }
  return stops[stops.length - 1]![1];
}
export const paceColor = (rate: number): string => `rgb(${paceRGB(rate).join(',')})`;
const paceFill = (rate: number, a: number): string => `rgba(${paceRGB(rate).join(',')},${a})`;

/** Подписи вариантов для переключателя в «деталях». */
export const TEMPO_LABELS: Record<TempoKind, string> = {
  race: 'гонка',
  line: 'линия',
};

/** Пояснения ⓘ к каждому варианту графика темпа. */
export const TEMPO_INFO: Record<TempoKind, string> = {
  line: 'Линия — накопленные траты по дням месяца; пунктир — ровный график бюджета; полая точка — итог при текущем темпе. Цвет — температура: белый — тратите мало, зелёный — в графике, красный — перегрев. В «деталях» ползунок «Что если» крутит прогноз.',
  race: 'Две шкалы, у каждой свой финиш справа: «дни месяца» — до конца месяца, «бюджет» — до 100% лимита. Бюджет бежит впереди дней — перебираете; штриховка и пунктирная риска за краем — перебор за бюджет. Ползунок «Что если» в деталях двигает риску.',
};

/** Вариант hero-графика темпа: «гонка» по умолчанию, «линия» — альтернатива. */
export type TempoKind = 'line' | 'race';

/** Общие данные для всех вариантов графика темпа. */
export interface TempoProps {
  daily: readonly number[];
  today: number;
  dim: number;
  cap: number;
  spent: number;
  proj: number;
  rate: number;
  effRate: number;
  scenario: boolean;
}

/**
 * График темпа месяца (grafana-style): накопленные траты — плавная линия
 * со свечением и градиентной заливкой; ровный график бюджета — пунктир;
 * вертикаль «сейчас»; полая точка — прогноз итога при текущем темпе.
 * Цвет — «температура»: холодно → зелёный → янтарь → красный.
 */
export function TempoChart({ daily, today, dim, cap, proj, rate, effRate, scenario }: TempoProps) {
  const color = paceColor(rate);
  const projColor = paceColor(effRate);
  const W = 320;
  const H = 140;
  const padL = 4;
  const padR = 10;
  const padT = 12;
  const padB = 4;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const cum: number[] = [];
  for (let i = 0; i < dim; i++) cum.push((cum[i - 1] ?? 0) + (daily[i] ?? 0));
  const cumToday = cum[today - 1] ?? 0;
  const yMax = Math.max(cap, proj, cumToday, 1) * 1.07;
  const x = (d: number) => padL + (dim > 1 ? ((d - 1) / (dim - 1)) * plotW : plotW / 2);
  const y = (v: number) => padT + (1 - v / yMax) * plotH;
  const yBase = y(0);
  const px = Array.from({ length: today }, (_, i) => x(i + 1));
  const py = px.map((_, i) => y(cum[i]!));
  const line = smoothPath(px, py);
  const area = `${line}L${x(today).toFixed(1)},${yBase.toFixed(1)}L${px[0]!.toFixed(1)},${yBase.toFixed(1)}Z`;
  const projY = y(Math.min(proj, yMax * 0.97));
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="mt-1 block h-36 w-full" aria-hidden>
      <defs>
        <linearGradient id="tempoFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="60%" stopColor={color} stopOpacity="0.12" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="tempoProjFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={projColor} stopOpacity="0.35" />
          <stop offset="100%" stopColor={projColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* сетка: половина и потолок бюджета + нулевая ось */}
      {cap > 0 && <line x1={padL} y1={y(cap / 2)} x2={W - padR} y2={y(cap / 2)} class="stroke-zinc-700" strokeWidth="0.7" strokeDasharray="2 4" opacity="0.5" />}
      {cap > 0 && <line x1={padL} y1={y(cap)} x2={W - padR} y2={y(cap)} class="stroke-zinc-700" strokeWidth="0.9" strokeDasharray="4 3" opacity="0.8" />}
      <line x1={padL} y1={yBase} x2={W - padR} y2={yBase} class="stroke-zinc-600" strokeWidth="1" />
      {/* вертикаль «сейчас» — как now-line в Grafana */}
      <line x1={x(today)} y1={padT} x2={x(today)} y2={yBase} class="stroke-zinc-500" strokeWidth="0.9" opacity="0.45" />
      {/* идеал: ровный график «бюджет/день × день» */}
      <line x1={x(1)} y1={yBase} x2={x(dim)} y2={y(cap)} class="stroke-zinc-400" strokeWidth="1.1" strokeDasharray="5 3" opacity="0.75" />
      <path d={area} fill="url(#tempoFill)" />
      {/* свечение + сама линия факта */}
      <path d={line} fill="none" stroke={color} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" opacity="0.18" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      {proj > 0 && scenario && (
        <path
          d={`M${x(today).toFixed(1)},${y(cumToday).toFixed(1)} L${x(dim).toFixed(1)},${projY.toFixed(1)} L${x(dim).toFixed(1)},${yBase.toFixed(1)} L${x(today).toFixed(1)},${yBase.toFixed(1)} Z`}
          fill="url(#tempoProjFill)"
        />
      )}
      {proj > 0 && (
        <line
          x1={x(today)}
          y1={y(cumToday)}
          x2={x(dim)}
          y2={projY}
          stroke={projColor}
          strokeWidth={scenario ? 2.4 : 1.6}
          strokeDasharray={scenario ? undefined : '2.5 3'}
          opacity={scenario ? 1 : 0.85}
        />
      )}
      {/* точка «сегодня» с ореолом + кольцо прогноза */}
      <circle cx={x(today)} cy={y(cumToday)} r="6" fill={color} opacity="0.2" />
      <circle cx={x(today)} cy={y(cumToday)} r="3.2" fill={color} class="stroke-zinc-900" strokeWidth="1" />
      {proj > 0 && <circle cx={x(dim)} cy={projY} r="4" class="fill-zinc-900" stroke={projColor} strokeWidth="1.6" />}
      </svg>
      <div class="flex items-center justify-between text-[10px] text-zinc-600">
        <span>1</span>
        <span>день {today}</span>
        <span>{dim}</span>
      </div>
    </>
  );
}

/**
 * «Гонка»: две шкалы, у каждой СВОЙ финиш на правом краю —
 * «дни месяца» всегда 0→конец месяца, «бюджет» 0→100% лимита.
 * Перебор (прогноз > 100%) вылезает за правый край трека — штриховка
 * и пунктирная риска торчат за финишем. pr-8 резервирует место хвосту.
 */
export function RaceChart({ today, dim, cap, spent, proj, rate, effRate, scenario }: TempoProps) {
  const dayShare = dim > 0 ? today / dim : 0;
  const spentShare = cap > 0 ? spent / cap : 0;
  const projShare = cap > 0 && proj > 0 ? proj / cap : 0;
  const tailShare = Math.min(Math.max(projShare, 0), 1.1);
  const pct = (s: number) => `${(Math.min(s, 1.1) * 100).toFixed(1)}%`;
  const effC = paceColor(effRate);
  return (
    <div class="mt-4 space-y-4 pr-8">
      <div>
        <div class="mb-1 flex justify-between text-[11px] text-zinc-500">
          <span>дни месяца</span>
          <span>
            {today}/{dim}
          </span>
        </div>
        <div class="relative h-3.5 rounded-full bg-zinc-800/80">
          <div
            class="absolute inset-y-0 left-0 rounded-full"
            style={{ width: pct(Math.min(dayShare, 1)), background: 'linear-gradient(90deg,var(--color-zinc-500),var(--color-zinc-400))' }}
          />
        </div>
      </div>
      <div>
        <div class="mb-1 flex justify-between text-[11px] text-zinc-500">
          <span>бюджет</span>
          <span>{Math.round(spentShare * 100)}%</span>
        </div>
        <div class="relative h-3.5 rounded-full bg-zinc-800/80">
          <div
            class="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: pct(Math.min(spentShare, 1)),
              background: `linear-gradient(90deg, ${paceFill(rate, 0.3)}, ${paceColor(rate)})`,
            }}
          />
          {/* «Что если»: штриховой хвост от текущего уровня до прогноза — за финишем перебор */}
          {projShare > spentShare && scenario && (
            <div
              class="absolute inset-y-0"
              style={{
                left: pct(Math.min(spentShare, 1)),
                width: pct(Math.max(tailShare - spentShare, 0)),
                background: `repeating-linear-gradient(45deg, ${paceFill(effRate, 0.55)} 0 3px, transparent 3px 7px)`,
              }}
            />
          )}
          {/* финиш бюджета — правый край трека; виден отдельно при переборе */}
          {projShare > 1 && <div class="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-red-400/80" style={{ left: '100%' }} />}
          {/* пунктирная риска итога — может стоять за финишем */}
          {proj > 0 && (
            <div
              class="absolute -inset-y-1 w-0 -translate-x-1/2 border-r-2 border-dashed"
              style={{ left: pct(tailShare), borderColor: effC }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const DOW_NAMES = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;

/**
 * «Неделя-гонка» — инструмент дня: «дни недели» (пн–вс, спайк-зона
 * вечер пятницы → вс) vs «бюджет недели». У каждой шкалы свой финиш
 * справа; перебор вылезает за край — штриховка и риска за финишем.
 */
export function WeekRace({ day, budget, spent, proj, rate, effRate, scenario }: {
  day: number; // 1=пн..7=вс
  budget: number;
  spent: number;
  proj: number;
  rate: number;
  effRate: number;
  scenario: boolean;
}) {
  const spentShare = budget > 0 ? spent / budget : 0;
  const projShare = budget > 0 && proj > 0 ? proj / budget : 0;
  const tailShare = Math.min(Math.max(projShare, 0), 1.1);
  const pct = (s: number) => `${(Math.min(s, 1.1) * 100).toFixed(1)}%`;
  const effC = paceColor(effRate);
  return (
    <div class="mt-4 space-y-4 pr-8">
      <div>
        <div class="mb-1 flex justify-between text-[11px] text-zinc-500">
          <span>дни недели</span>
          <span>
            {DOW_NAMES[day - 1]} · {day}/7
          </span>
        </div>
        <div class="relative h-3.5 rounded-full bg-zinc-800/80">
          {/* спайк-зона: вечер пятницы → воскресенье */}
          <div
            class="absolute inset-y-0 rounded-r-full bg-amber-200/[0.07]"
            style={{ left: `${(4 / 7) * 100}%`, width: `${(3 / 7) * 100}%` }}
          />
          <div
            class="absolute inset-y-0 left-0 rounded-full"
            style={{ width: pct(day / 7), background: 'linear-gradient(90deg,var(--color-zinc-500),var(--color-zinc-400))' }}
          />
        </div>
        <div class="mt-1 grid grid-cols-7 text-center text-[9px] leading-none">
          {DOW_NAMES.map((d, i) => (
            <span
              key={d}
              class={
                i === day - 1
                  ? 'text-zinc-200'
                  : i >= 5
                    ? 'text-amber-400/70'
                    : i === 4
                      ? 'text-amber-400/40'
                      : i < day - 1
                        ? 'text-zinc-500'
                        : 'text-zinc-700'
              }
            >
              {d}
            </span>
          ))}
        </div>
      </div>
      <div>
        <div class="mb-1 flex justify-between text-[11px] text-zinc-500">
          <span>бюджет недели</span>
          <span>{Math.round(spentShare * 100)}%</span>
        </div>
        <div class="relative h-3.5 rounded-full bg-zinc-800/80">
          <div
            class="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: pct(Math.min(spentShare, 1)),
              background: `linear-gradient(90deg, ${paceFill(rate, 0.3)}, ${paceColor(rate)})`,
            }}
          />
          {/* «Что если»: штриховой хвост до прогноза — за финишем перебор недели */}
          {projShare > spentShare && scenario && (
            <div
              class="absolute inset-y-0"
              style={{
                left: pct(Math.min(spentShare, 1)),
                width: pct(Math.max(tailShare - spentShare, 0)),
                background: `repeating-linear-gradient(45deg, ${paceFill(effRate, 0.55)} 0 3px, transparent 3px 7px)`,
              }}
            />
          )}
          {projShare > 1 && <div class="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-red-400/80" style={{ left: '100%' }} />}
          {proj > 0 && (
            <div
              class="absolute -inset-y-1 w-0 -translate-x-1/2 border-r-2 border-dashed"
              style={{ left: pct(tailShare), borderColor: effC }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
