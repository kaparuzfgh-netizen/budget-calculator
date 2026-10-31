/** format.ts — форматирование для сообщений бота. */

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', RUB: '₽', KGS: 'с', KZT: '₸', UAH: '₴', GEL: '₾',
  AMD: '֏', AZN: '₼', BYN: 'Br', TRY: '₺', GBP: '£', JPY: '¥', CNY: '¥',
  KRW: '₩', INR: '₹', THB: '฿', VND: '₫', PLN: 'zł', CZK: 'Kč', HUF: 'Ft',
};

/** fmtMoney_: 44 282 ₽ · 1 234,50 $ — тысячи NBSP, 0 или 2 знака. */
export function fmtMoney(amount: number, currency: string): string {
  const c = currency.toUpperCase();
  const sym = SYMBOLS[c] ?? c;
  const dec = Number.isInteger(amount) ? 0 : 2;
  const [int, frac] = Math.abs(amount).toFixed(dec).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = amount < 0 ? '−' : '';
  return `${sign}${grouped}${frac ? ',' + frac : ''} ${sym}`;
}

export function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
