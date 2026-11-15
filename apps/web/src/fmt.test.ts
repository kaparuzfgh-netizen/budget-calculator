/**
 * fmt.test.ts — unit-тесты форматирования и клиентской валидации (A2-4).
 * fmtMoney — зеркало apps/api/src/bot/format.ts: правки держать синхронно.
 */
import { describe, expect, it } from 'vitest';
import {
  amountError,
  currencyError,
  dayError,
  fmtAuto,
  fmtCompact,
  fmtDay,
  fmtMinor,
  fmtMoney,
  fmtPct,
  nameError,
  noteError,
  parseAmount,
  timezoneError,
} from './fmt';

const NBSP = ' ';

describe('fmtMoney / fmtMinor / fmtPct', () => {
  it('целые — без дробной части, тысячи через NBSP, символ валюты', () => {
    expect(fmtMoney(44282, 'RUB')).toBe(`44${NBSP}282${NBSP}₽`);
    expect(fmtMoney(0, 'USD')).toBe(`0${NBSP}$`);
    expect(fmtMoney(1234.5, 'EUR')).toBe(`1${NBSP}234,50${NBSP}€`);
    // неизвестная валюта — кодом
    expect(fmtMoney(10, 'XYZ')).toBe(`10${NBSP}XYZ`);
  });
  it('отрицательные — минус U+2212 перед суммой', () => {
    expect(fmtMoney(-1500, 'RUB')).toBe(`−1${NBSP}500${NBSP}₽`);
  });
  it('minor units → major', () => {
    expect(fmtMinor(123456, 'RUB')).toBe(`1${NBSP}234,56${NBSP}₽`);
  });
  it('fmtPct — один знак', () => {
    expect(fmtPct(0.856)).toBe('85.6%');
    expect(fmtPct(1)).toBe('100.0%');
  });
});

describe('fmtCompact / fmtAuto', () => {
  it('миллионы и миллиарды — компактно с запятой', () => {
    expect(fmtCompact(182_400_000, 'VND')).toBe('182,4 млн ₫');
    expect(fmtCompact(1_200_000_000, 'RUB')).toBe('1,2 млрд ₽');
  });
  it('fmtAuto переключается на 1 млн', () => {
    expect(fmtAuto(999_999, 'RUB')).toBe(`999${NBSP}999${NBSP}₽`);
    expect(fmtAuto(1_000_000, 'RUB')).toBe('1,0 млн ₽');
  });
});

describe('parseAmount / amountError', () => {
  it('пробелы и запятая → число; мусор → null', () => {
    expect(parseAmount('1 234,56')).toBe(1234.56);
    expect(parseAmount('49.90')).toBe(49.9);
    expect(parseAmount(' 250 ')).toBe(250);
    expect(parseAmount('abc')).toBe(null);
    expect(parseAmount('')).toBe(null);
  });
  it('amountError: не число / ≤0 / >1e9 → текст; валидное → null', () => {
    expect(amountError('abc')).toContain('числом');
    expect(amountError('0')).toContain('больше нуля');
    expect(amountError('-5')).toContain('больше нуля');
    expect(amountError('1000000001')).toContain('большая сумма');
    expect(amountError('1000000000')).toBe(null); // граница включительно
    expect(amountError('500')).toBe(null);
  });
});

describe('currencyError / dayError / nameError / noteError / timezoneError', () => {
  it('валюта — 3–5 латинских; регистр не важен', () => {
    expect(currencyError('USD')).toBe(null);
    expect(currencyError('usd')).toBe(null);
    expect(currencyError('USDT')).toBe(null);
    expect(currencyError('US')).not.toBe(null);
    expect(currencyError('123')).not.toBe(null);
  });
  it('день платежа: пусто ок; иначе 1–31', () => {
    expect(dayError('')).toBe(null);
    expect(dayError('15')).toBe(null);
    expect(dayError('0')).not.toBe(null);
    expect(dayError('32')).not.toBe(null);
    expect(dayError('2.5')).not.toBe(null);
  });
  it('имя/заметка — длины', () => {
    expect(nameError('Аренда')).toBe(null);
    expect(nameError(' ')).not.toBe(null);
    expect(nameError('x'.repeat(61))).not.toBe(null);
    expect(noteError('коротко')).toBe(null);
    expect(noteError('x'.repeat(201))).not.toBe(null);
  });
  it('таймзона — IANA через Intl', () => {
    expect(timezoneError('Europe/Moscow')).toBe(null);
    expect(timezoneError('UTC')).toBe(null);
    expect(timezoneError('Mars/Olympus')).not.toBe(null);
    expect(timezoneError('')).not.toBe(null);
  });
});

describe('fmtDay', () => {
  it('ISO → ДД.ММ; мусор — как есть', () => {
    expect(fmtDay('2026-11-05')).toBe('05.11');
    expect(fmtDay('broken')).toBe('broken');
  });
});
