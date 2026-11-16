/**
 * crypto.ts — шифрование пользовательских данных at rest (вариант A).
 * Per-user ключ: HKDF-SHA256 от секрета DATA_KEY → AES-GCM 256.
 * Формат значения: 'enc1:' + base64url(iv(12B) || ciphertext+tag);
 * AAD = `${table}.${col}:${userId}` — шифртекст привязан к юзеру/таблице/колонке.
 * Толерантное чтение: значение без префикса 'enc1:' — legacy-plaintext,
 * возвращается как есть; с префиксом и битым — ошибка (молча не отдаём мусор).
 * Fail closed: без DATA_KEY encrypt бросает — plaintext не пишется никогда.
 * Web Crypto only (workerd); никаких node:*.
 */
const SALT = 'budget-companion/data/v1';
const PREFIX = 'enc1:';

let master: Uint8Array | null = null;
let masterRaw: string | null = null;
/** Кэш производных ключей: `${userId}` → CryptoKey (инвалидируется при смене DATA_KEY). */
const keys = new Map<string, Promise<CryptoKey>>();
const b64u = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uDec = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Настроить мастер-ключ из env (вызывается на каждом запросе/тике). */
export function configureDataKey(raw: string | undefined) {
  if (raw === masterRaw) return; // уже настроен — кэш ключей валиден
  masterRaw = raw ?? null;
  master = null;
  keys.clear(); // смена секрета инвалидирует производные ключи
  if (raw === undefined || raw === '') return;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('DATA_KEY: невалидный base64');
  }
  if (bytes.length !== 32) throw new Error(`DATA_KEY: ожидается 32 байта, получено ${bytes.length}`);
  master = bytes;
}
export const hasDataKey = () => master !== null;
export function assertDataKey() {
  if (!master) throw new Error('data key not configured');
}

async function keyFor(userId: number): Promise<CryptoKey> {
  assertDataKey();
  const k = `${userId}`;
  let p = keys.get(k);
  if (!p) {
    const info = new TextEncoder().encode(`user:${userId}`);
    p = (async () => {
      const ikm = await crypto.subtle.importKey('raw', master!, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(SALT), info },
        ikm,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keys.set(k, p);
  }
  return p;
}

export async function encStr(userId: number, table: string, col: string, v: string | null | undefined) {
  if (v === null || v === undefined) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${table}.${col}:${userId}`) },
    await keyFor(userId),
    new TextEncoder().encode(v),
  );
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv);
  buf.set(new Uint8Array(ct), 12);
  return PREFIX + b64u(buf);
}
export const encNum = (userId: number, table: string, col: string, v: number | null | undefined) =>
  v === null || v === undefined ? Promise.resolve(null) : encStr(userId, table, col, String(v));

export async function decStr(userId: number, table: string, col: string, v: unknown): Promise<string | null> {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return String(v); // legacy plaintext
  const raw = b64uDec(v.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: raw.subarray(0, 12),
      additionalData: new TextEncoder().encode(`${table}.${col}:${userId}`),
    },
    await keyFor(userId),
    raw.subarray(12),
  );
  return new TextDecoder().decode(pt);
}
export async function decNum(userId: number, table: string, col: string, v: unknown): Promise<number | null> {
  const s = await decStr(userId, table, col, v);
  return s === null ? null : Number(s);
}

/** Спек зашифрованных колонок: только они шифруются; остальное — plaintext. */
export type FieldsSpec = Record<string, Record<string, 'num' | 'str'>>;
export const FIELDS: FieldsSpec = {
  profiles: {
    income_minor: 'num',
    living_cap_minor: 'num',
    weekly_budget_minor: 'num',
    cushion_minor: 'num',
  },
  commitments: { name: 'str', amount_minor: 'num' },
  commitment_payments: { amount_minor: 'num' },
  commitment_changes: { old_val: 'str', new_val: 'str' },
  weekly_expenses: { amount_minor: 'num', note: 'str' },
  income_entries: { amount_minor: 'num', note: 'str' },
  debts: { name: 'str', rate: 'num', initial_balance_minor: 'num', initial_payment_minor: 'num' },
  debt_events: { amount_minor: 'num' },
  loans: { counterparty: 'str', amount_minor: 'num', note: 'str' },
  loan_events: { amount_minor: 'num' },
  exchanges: { amount_from_minor: 'num', amount_to_minor: 'num', rate: 'num', note: 'str' },
  conversation_state: { data: 'str' },
  categories: { name: 'str', emoji: 'str' },
  // uid для users — PK id (колонки user_id нет): decRow берёт id, backfill — WHERE id=?
  users: { display_name: 'str' },
  // uid для households — тоже PK id (общий бюджет пары): ключ от household.id
  households: { living_cap_minor: 'num', weekly_budget_minor: 'num' },
};

/** Дешифровать строку по FIELDS-спеку (null → null). */
export async function decRow<T>(table: keyof typeof FIELDS & string, row: T | null | undefined): Promise<T | null> {
  if (!row) return row ?? null;
  const r = row as Record<string, unknown>;
  const userId = Number(r.user_id ?? r.id); // users: uid = PK id, колонки user_id нет
  for (const [col, kind] of Object.entries(FIELDS[table] ?? {})) {
    if (r[col] === null || r[col] === undefined) continue;
    r[col] = kind === 'num' ? await decNum(userId, table, col, r[col]) : await decStr(userId, table, col, r[col]);
  }
  return row;
}
/** Дешифровать результат .all() (объект с .results) — форма ответа не меняется. */
export async function decRows<R extends { results: unknown[] }>(table: keyof typeof FIELDS & string, res: R): Promise<R> {
  res.results = await Promise.all(res.results.map((r) => decRow(table, r)));
  return res;
}
/** Зашифровать поля объекта по FIELDS-спеку (in-place; вернуть тот же объект). */
export async function encRow<T extends Record<string, unknown>>(table: keyof typeof FIELDS & string, userId: number, obj: T): Promise<T> {
  for (const [col, kind] of Object.entries(FIELDS[table] ?? {})) {
    const v = obj[col];
    if (v === null || v === undefined) continue;
    (obj as Record<string, unknown>)[col] = kind === 'num' ? await encNum(userId, table, col, v as number) : await encStr(userId, table, col, v as string);
  }
  return obj;
}
