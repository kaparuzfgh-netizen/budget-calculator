import type { Env } from '../../env';

/** Общий контекст частей scoped-репозитория. */
export interface Ctx {
  db: Env['DB'];
  userId: number;
  /** Шифрование поля по FIELDS-спеку; колонки вне спека — plaintext. */
  en: (table: string, col: string, v: unknown) => Promise<string | number | null>;
}
