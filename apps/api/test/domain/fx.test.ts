/**
 * domain/fx.test.ts — золотые значения порта FXAnalytics.gs (шаг 8).
 * Эталоны посчитаны «на бумаге» по формулам из apps-script/FXAnalytics.gs —
 * порт обязан совпадать один-в-один (RSI — простое усреднение, std — выборочная).
 */
import { describe, expect, it } from 'vitest';
import {
  cross_,
  forecast_,
  makeAction_,
  mean_,
  rsi_,
  signal_,
  slopeRel_,
  sma_,
  stats_,
  std_,
  type FxPoint,
} from '../../src/domain/fx';

const pts = (vs: number[]): FxPoint[] => vs.map((v, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, v }));
const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('cross_', () => {
  it('перемножает только совпадающие даты', () => {
    const a = pts([2, 3, 4]); // d1..d3
    const b = [
      { date: '2026-01-02', v: 10 },
      { date: '2026-01-01', v: 5 },
      { date: '2026-01-04', v: 7 },
    ];
    expect(cross_(a, b)).toEqual([
      { date: '2026-01-01', v: 10 },
      { date: '2026-01-02', v: 30 },
    ]);
  });
  it('пустая вторая серия → пустой кросс', () => {
    expect(cross_(pts([1, 2]), [])).toEqual([]);
  });
});

describe('mean_/std_/sma_', () => {
  it('mean — среднее', () => close(mean_([1, 2, 3]), 2));
  it('std — ВЫБОРОЧНАЯ (n−1), как в v1', () => {
    close(std_([1, 2, 3]), 1); // ((1)^2+0+(1)^2)/2
    close(std_([2, 4, 6, 8, 10]), Math.sqrt(40 / 4)); // var=10 → √10
    expect(std_([7])).toBe(0); // <2 → 0
  });
  it('sma — последние n (или все, если ряд короче)', () => {
    close(sma_([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), 9);
    close(sma_([1, 2], 50), 1.5);
  });
});

describe('rsi_', () => {
  it('монотонный рост → 100, монотонное падение → 0', () => {
    expect(rsi_([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(100);
    expect(rsi_([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe(0);
  });
  it('пилюля ±1 → rs=1 → 50', () => {
    expect(rsi_([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1])).toBe(50);
  });
  it('простое усреднение последних 14 диффов (не Wilder)', () => {
    // 16 точек: первый дифф (за пределами окна) гигантский — он не влияет
    const closes = [1000, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1];
    expect(rsi_(closes)).toBe(50);
  });
  it('< period+1 точек → 50', () => expect(rsi_([1, 2, 3])).toBe(50));
});

describe('slopeRel_', () => {
  it('линейный ряд y=2i+3 → наклон 2, rel = 2/cur', () => {
    close(slopeRel_([3, 5, 7, 9, 11], 30), 2 / 11);
  });
  it('плоский ряд → 0', () => expect(slopeRel_([5, 5, 5, 5, 5], 30)).toBe(0));
  it('<3 точек → 0', () => expect(slopeRel_([1, 2], 30)).toBe(0));
});

describe('forecast_', () => {
  it('плоский ряд → точка без разброса', () => {
    const f = forecast_([5, 5, 5, 5, 5], 7);
    expect(f).toEqual({ low: 5, mid: 5, high: 5 });
  });
  it('детерминированный тренд: mid на трендовой линии, low<mid<high при σ>0', () => {
    const f = forecast_([3, 5, 7, 9, 11], 1);
    expect(f.mid).toBeCloseTo(13, 4); // cur*(1+slope*1) = 11*(1+2/11)=13
    // доходности 2i+3 разные → σ>0 → разброс ненулевой
    expect(f.low).toBeLessThan(f.mid);
    expect(f.high).toBeGreaterThan(f.mid);
  });
});

describe('stats_', () => {
  const up = pts(Array.from({ length: 30 }, (_, i) => i + 1)); // 1..30
  it('<30 точек → null', () => {
    expect(stats_(pts(new Array(29).fill(1)))).toBeNull();
  });
  it('монотонный рост 1..30: current=30, percentile=100, RSI=100, тренд вверх', () => {
    const st = stats_(up)!;
    expect(st.current).toBe(30);
    expect(st.percentile).toBe(100); // все 30 точек ≤ 30
    expect(st.min).toBe(1);
    expect(st.max).toBe(30);
    expect(st.digits).toBe(2); // cur > 20
    expect(st.rsi14).toBe(100);
    expect(st.trendUp).toBe(true);
    expect(st.change30dPct).toBe(0); // n==30 → ветка n>30 отключена
    // z180 = (30 − mean)/std; mean(1..30)=15.5, std выборочная ≈ 8.8034
    close(st.z180, (30 - 15.5) / Math.sqrt(77.5), 1e-6);
    expect(st.series).toHaveLength(30); // slice(-90)
  });
  it('монотонное падение → percentile=3 (только минимум ≤ cur)', () => {
    const st = stats_(pts(Array.from({ length: 30 }, (_, i) => 31 - i)))!; // 30..2
    expect(st.current).toBe(2);
    expect(st.percentile).toBe(3); // round(100*1/30) = 3
    expect(st.trendUp).toBe(false);
  });
  it('40 точек: change30dPct считается от closes[n-31]', () => {
    const vs = Array.from({ length: 40 }, (_, i) => 100 + i); // 100..139
    const st = stats_(pts(vs))!;
    close(st.change30dPct, 139 / 109 - 1); // cur / closes[9]
    expect(st.series).toHaveLength(40);
  });
  it('digits: cur ≤ 20 → 4 знака', () => {
    const st = stats_(pts(Array.from({ length: 30 }, (_, i) => 1 + i * 0.01)))!;
    expect(st.digits).toBe(4);
  });
});

describe('signal_ — пороги из v1', () => {
  const base = { z180: 1.5, band30: 0.1, move30: 0.2, rsi14: 50 };
  it('боковик |z180|<0.5 → split «боковик» независимо от перцентиля', () => {
    const s = signal_({ ...base, z180: 0.3, percentile: 95 });
    expect(s.signal).toBe('split');
    expect(s.text).toContain('боковик');
  });
  it('боковик: тренд тише половины шума → split «боковик»', () => {
    const s = signal_({ z180: 1.5, band30: 1, move30: 0.3, percentile: 95, rsi14: 50 });
    expect(s.signal).toBe('split');
  });
  it('score ≥ 70 → convert', () => {
    expect(signal_({ ...base, percentile: 80 }).signal).toBe('convert');
    expect(signal_({ ...base, percentile: 70 }).signal).toBe('convert');
  });
  it('45–69 → split «Нейтрально»', () => {
    const s = signal_({ ...base, percentile: 60 });
    expect(s.signal).toBe('split');
    expect(s.text).not.toContain('боковик');
  });
  it('30–44 → wait; <30 → hold', () => {
    expect(signal_({ ...base, percentile: 40 }).signal).toBe('wait');
    expect(signal_({ ...base, percentile: 30 }).signal).toBe('wait');
    expect(signal_({ ...base, percentile: 29 }).signal).toBe('hold');
  });
  it('RSI-бонусы: ≥65 → +5, ≤35 → −5', () => {
    expect(signal_({ ...base, percentile: 66, rsi14: 70 }).signal).toBe('convert'); // 66+5≥70
    expect(signal_({ ...base, percentile: 33, rsi14: 30 }).signal).toBe('hold'); // 33−5=28 <30
    expect(signal_({ ...base, percentile: 40, rsi14: 30 }).signal).toBe('wait'); // 40−5=35 → wait
  });
});

describe('makeAction_', () => {
  it('<30 → null; ≥30 → полная карточка', () => {
    expect(makeAction_(pts(new Array(10).fill(1)), 'k', 'L', 'p', '💱')).toBeNull();
    const a = makeAction_(pts(Array.from({ length: 40 }, (_, i) => 100 + i)), 'eur_rub', 'EUR → RUB', 'жизнь', '🛒')!;
    expect(a.key).toBe('eur_rub');
    expect(a.label).toBe('EUR → RUB');
    expect(a.change30d_pct).toBe(Math.round(a.change30d_pct * 10) / 10);
    expect(a.series).toHaveLength(40);
  });
});
