import { describe, expect, it } from 'vitest';
import { compareDec, formatDec, isCanonicalDec, mulToMinor, normalizeDec, parseDec } from '../../src/domain/decimal';

describe('decimal: разбор и формат', () => {
  it('8 знаков сохраняются без потерь', () => {
    expect(formatDec(parseDec('0.12345678'))).toBe('0.12345678');
    expect(normalizeDec('0,5')).toBe('0.5');
    expect(normalizeDec('007.500')).toBe('7.5');
    expect(normalizeDec('12.00')).toBe('12');
  });
  it('мусор и нули отклоняются', () => {
    for (const bad of ['1e3', '-1', '0', '0.000', '0.123456789', 'NaN', '', '1.2.3', '1234567890123'])
      expect(() => parseDec(bad), bad).toThrow();
  });
  it('isCanonicalDec', () => {
    expect(isCanonicalDec('0.1')).toBe(true);
    expect(isCanonicalDec('10')).toBe(true);
    expect(isCanonicalDec('0')).toBe(false);
    expect(isCanonicalDec('1.50')).toBe(false);
    expect(isCanonicalDec('01')).toBe(false);
    expect(isCanonicalDec('1,5')).toBe(false);
  });
  it('compareDec', () => {
    expect(compareDec(parseDec('1.5'), parseDec('1.50000001'))).toBe(-1);
    expect(compareDec(parseDec('2'), parseDec('2'))).toBe(0);
    expect(compareDec(parseDec('3'), parseDec('2.9'))).toBe(1);
  });
});

describe('decimal: mulToMinor', () => {
  it('точное произведение', () => {
    expect(mulToMinor('0.1', '30000.5')).toBe(300005);
    expect(mulToMinor('0.00000001', '1')).toBe(0);
    expect(mulToMinor('2', '0.005')).toBe(1); // 0.01 → 1 minor
  });
  it('половина minor-единицы округляется вверх', () => {
    expect(mulToMinor('1', '0.005')).toBe(1); // 0.5 minor → 1
    expect(mulToMinor('1', '0.004')).toBe(0);
  });
  it('переполнение → TOO_LARGE', () => {
    expect(() => mulToMinor('999999999999', '999999999999')).toThrow(/велика/);
  });
});
