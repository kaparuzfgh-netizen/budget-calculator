/** Ошибка домена: code — машиночитаемый, message — по-русски для UI/лога. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Число: конечное; при positive — > 0; при nonNegative — >= 0. */
export function num(value: number, field: string, opts: { positive?: boolean; nonNegative?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DomainError('BAD_NUMBER', `Поле ${field}: ожидалось конечное число, получено ${String(value)}`);
  }
  if (opts.positive && value <= 0) {
    throw new DomainError('BAD_NUMBER', `Поле ${field}: ожидалось положительное число, получено ${value}`);
  }
  if (opts.nonNegative && value < 0) {
    throw new DomainError('BAD_NUMBER', `Поле ${field}: ожидалось неотрицательное число, получено ${value}`);
  }
  return value;
}
