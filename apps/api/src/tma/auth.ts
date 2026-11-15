/**
 * tma/auth.ts — аутентификация Telegram Mini App (шаг 5, ADR-0001).
 *
 * Только Web Crypto (workerd), никаких node:crypto/Buffer:
 *  1. verifyInitData — проверка `WebApp.initData` по документации Telegram:
 *     data-check-string = поля без `hash`, отсортированные по ключу, `k=v` через \n;
 *     secret = HMAC_SHA256(key="WebAppData", data=botToken);
 *     ожидаемый hash = HMAC_SHA256(key=secret, data=data-check-string) в hex.
 *     Дополнительно: auth_date не старше 24ч (и не из будущего >5 мин),
 *     поле `user` обязательно и содержит числовой `id`.
 *  2. signJwt/verifyJwt — сессионный JWT HS256 ({tg_id, iat, exp}), TTL 12ч.
 *     Сравнения подписей — через timingSafeEqualStr (без раннего выхода).
 */
import { timingSafeEqualStr } from '../http/security';

const TE = new TextEncoder();
const TD = new TextDecoder();

/** initData «живёт» 24 часа; небольшой допуск на расхождение часов клиента. */
const INIT_DATA_TTL_MS = 24 * 3600 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const TMA_JWT_TTL_SEC = 12 * 3600;

async function hmacSha256(keyData: ArrayBuffer | Uint8Array | string, message: string): Promise<ArrayBuffer> {
  const raw = typeof keyData === 'string' ? TE.encode(keyData) : keyData;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, TE.encode(message));
}

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  } catch {
    return null;
  }
}

export interface TmaUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export type InitDataResult =
  | { ok: true; user: TmaUser }
  | { ok: false; reason: 'parse' | 'hash' | 'signature' | 'auth_date' | 'user' };

/**
 * Проверка Telegram WebApp initData. Возвращает распарсенного user или
 * причину отказа (в логи — только reason, сам initData не логируем).
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
): Promise<InitDataResult> {
  if (!initData || initData.length > 8192 || !botToken) return { ok: false, reason: 'parse' };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'parse' };
  }
  const hash = (params.get('hash') ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return { ok: false, reason: 'hash' };

  const pairs: [string, string][] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push([key, value]);
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = await hmacSha256('WebAppData', botToken);
  const expected = hex(await hmacSha256(secret, dataCheckString));
  if (!(await timingSafeEqualStr(expected, hash))) return { ok: false, reason: 'signature' };

  const authDateMs = Number(params.get('auth_date')) * 1000;
  if (
    !Number.isFinite(authDateMs) ||
    authDateMs <= 0 ||
    now.getTime() - authDateMs > INIT_DATA_TTL_MS ||
    authDateMs - now.getTime() > FUTURE_SKEW_MS
  ) {
    return { ok: false, reason: 'auth_date' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'user' };
  let user: TmaUser;
  try {
    user = JSON.parse(userRaw) as TmaUser;
  } catch {
    return { ok: false, reason: 'user' };
  }
  if (typeof user.id !== 'number' || !Number.isFinite(user.id) || user.id <= 0) {
    return { ok: false, reason: 'user' };
  }
  return { ok: true, user };
}

/** Подписать JWT HS256: {alg,typ}.{…payload, iat, exp}.{sig}. */
export async function signJwt(payload: Record<string, unknown>, secret: string, ttlSec: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const encode = (o: unknown) => b64url(TE.encode(JSON.stringify(o)));
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ ...payload, iat: nowSec, exp: nowSec + ttlSec })}`;
  return `${data}.${b64url(await hmacSha256(secret, data))}`;
}

/** Проверить JWT HS256 → claims при валидной подписи и неистёкшем exp. */
export async function verifyJwt(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<{ tg_id: number } | null> {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  // A2-10: строгая проверка заголовка — принимаем только HS256/JWT.
  const hdr = fromB64url(parts[0]);
  if (!hdr) return null;
  try {
    const h = JSON.parse(TD.decode(hdr)) as { alg?: unknown; typ?: unknown };
    if (h.alg !== 'HS256' || h.typ !== 'JWT') return null;
  } catch {
    return null;
  }
  const data = `${parts[0]}.${parts[1]}`;
  const expected = b64url(await hmacSha256(secret, data));
  if (!(await timingSafeEqualStr(expected, parts[2]))) return null;
  const body = fromB64url(parts[1]);
  if (!body) return null;
  let payload: { tg_id?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(TD.decode(body)) as { tg_id?: unknown; exp?: unknown };
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now.getTime() / 1000)) return null;
  if (typeof payload.tg_id !== 'number' || !Number.isFinite(payload.tg_id)) return null;
  return { tg_id: payload.tg_id };
}
