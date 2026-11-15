/**
 * flows.test.ts — контракт реестра мастеров (services/flows.ts): маршрутизация
 * в access.ts перебирает флоу по порядку, поэтому реестры шагов обязаны не
 * пересекаться, а текстовые шаги — принадлежать своему флоу.
 */
import { describe, expect, it } from 'vitest';
import { DEBT_FLOW, FLOWS, flowOfStep, FX_FLOW, LOAN_FLOW, PF_FLOW, WIZARD_FLOWS } from '../src/services/flows';

describe('реестр флоу', () => {
  it('шаги флоу не пересекаются', () => {
    const seen = new Map<string, number>();
    FLOWS.forEach((f, i) => {
      for (const step of Object.keys(f.steps)) {
        expect(seen.get(step), `шаг ${step} в двух флоу`).toBeUndefined();
        seen.set(step, i);
      }
    });
  });

  it('текстовые шаги — подмножество шагов своего флоу', () => {
    for (const f of FLOWS) for (const step of f.textSteps) expect(step in f.steps, step).toBe(true);
  });

  it('flowOfStep однозначно находит владельца шага', () => {
    for (const f of FLOWS) for (const step of Object.keys(f.steps)) expect(flowOfStep(step)).toBe(f);
    expect(flowOfStep('spent_ask')).toBeUndefined();
    expect(flowOfStep('vs:recon')).toBeUndefined();
  });

  it('мастера: уникальные callback-префиксы и непересекающиеся экраны', () => {
    expect(WIZARD_FLOWS).toEqual([DEBT_FLOW, LOAN_FLOW, FX_FLOW]);
    const prefixes = WIZARD_FLOWS.map((f) => f.cbPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(p).toMatch(/^[a-z]+:$/);
    const screens = WIZARD_FLOWS.flatMap((f) => [...(f.screens ?? [])]);
    expect(new Set(screens).size).toBe(screens.length);
    expect(PF_FLOW.cbPrefix).toBeUndefined();
  });
});
