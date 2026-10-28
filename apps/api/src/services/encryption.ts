/**
 * encryption.ts — бэкфилл шифрования существующих plaintext-строк.
 * Дёргается из scheduled() каждый тик (до напоминаний, ошибки не блокируют):
 * идемпотентен (не-enc1: селект), ограничен limitPerTable за прогон,
 * CAS на исходные значения — конкурентная правка пользователя не затирается.
 */
import { encryptBackfill } from '../db/repo';
import type { Env } from '../env';

export async function runEncryptionBackfill(db: Env['DB'], limitPerTable = 200): Promise<number> {
  return encryptBackfill(db, limitPerTable);
}
