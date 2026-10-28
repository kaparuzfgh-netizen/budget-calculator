/**
 * tma/common.ts — общие кирпичики REST-роутов Mini App.
 * Вынесено из tma/api.ts, чтобы tma/debts.ts и следующие модули
 * переиспользовали auth-контракт, лимиты, zod-атомы и обработку ошибок,
 * не дублируя их. Все хелперы — чистые функции от Context.
 */
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../env';
import { scoped, type ScopedRepo, type UserRow } from '../db/repo';
import { getFxRates } from '../fx/service';
import { FxUnavailable, type FxProvider } from '../fx/provider';
import { DomainError } from '../domain/errors';

export type TmaContext = Context<{ Bindings: Env; Variables: { tmaUser: UserRow } }>;

/** Общие лимиты — те же, что у бота. */
export const LIMITS = {
  maxAmount: 1e9, // как parseAmount max
  maxCommitments: 30,
  maxDebts: 20, // P2-2: активные кредиты — реестр и replay не разрастаются
  maxLoans: 100, // P2-2: открытые займы (closed_at IS NULL)
  maxNote: 200,
  maxName: 60,
  clientIdMax: 64,
} as const;

export const CCY_RE = /^[A-Z]{3,5}$/;
export const CLIENT_ID_RE = /^[\w:.-]{1,64}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const err = (code: string, message: string, status: number) =>
  ({ status, body: { error: { code, message } } }) as const;
export const bad = (message: string) => err('validation', message, 400);
export const notFound = () => err('not_found', 'Не найдено', 404);

export const zCcy = z.string().trim().toUpperCase().regex(CCY_RE, 'валюта');
export const zAmount = z.number().finite().positive().max(LIMITS.maxAmount); // major units
export const zNote = z.string().trim().max(LIMITS.maxNote).optional();
export const zClientId = z.string().regex(CLIENT_ID_RE).optional();
export const zDay = z.number().int().min(1).max(31).nullable().optional();
/** 'YYYY-MM-DD' — реальная календарная дата. */
export const zIso = z
  .string()
  .regex(ISO_DATE_RE, 'дата в формате YYYY-MM-DD')
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'недопустимая дата');

export const repoOf = (c: TmaContext) => scoped(c.env.DB, c.get('tmaUser').id);

export const profile = async (repo: ScopedRepo) => {
  const p = await repo.getProfile();
  return p?.onboarded_at ? p : null;
};

export const notOnboarded = () => err('not_onboarded', 'Сначала настройка — /start', 403);

/** профиль или null — вызывающий отвечает 403 сам */
export const needProfile = async (c: TmaContext) => {
  const p = await profile(repoOf(c));
  if (!p) throw notOnboarded();
  return p;
};

export const fail = (e: unknown) => {
  if (e && typeof e === 'object' && 'body' in e && 'status' in e)
    return e as { status: number; body: unknown };
  if (e instanceof FxUnavailable) return err('fx_unavailable', 'Курсы недоступны — попробуйте позже', 503);
  if (e instanceof DomainError) return err('validation', e.message, 400);
  return null;
};

export const idOf = (c: TmaContext): number | null => {
  const id = Number(c.req.param('id'));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const okJson = (c: TmaContext, body: unknown, status = 200) => c.json(body, status as 200);

/** FX-резолвер как в боте (кэш D1 → провайдер). */
export const fxGet = (c: TmaContext, fx: FxProvider) => (ccys: string[]) =>
  getFxRates(c.env.DB, fx, ccys, new Date());
