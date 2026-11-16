/**
 * tma/household.ts — общий бюджет пары для Mini App (P2).
 * Членство проверяется на каждый запрос; наружу — только агрегаты
 * (суммы по людям, итог), строки трат партнёра не отдаются.
 * Приглашение — код-ссылка kind='household' (бот принимает /start hh_<код>).
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { UserRow } from '../db/repo';
import { accessRepo } from '../db/repo';
import { householdSummary } from '../services/household';
import { inviteLink, INVITE_TTL_MS } from '../bot/commands';
import {
  bad,
  err,
  fail,
  fxGet,
  notOnboarded,
  okJson,
  profile,
  repoOf,
  zAmount,
  zCcy,
  type TmaContext as C,
} from './common';

const zCap = z.object({ living_cap: zAmount, living_currency: zCcy });
const zJoin = z.object({ code: z.string().trim().min(8).max(80) });

/** SHA-256 hex — тот же способ, что в access.ts (код инвайта). */
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newInviteCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** код из ввода: ссылка t.me?start=hh_<code> | 'hh_<code>' | '<code>'. */
function parseInviteCode(raw: string): string {
  const m = /(?:start=)?(hh_)?([0-9a-f]{16,})/i.exec(raw.trim());
  return m?.[2]?.toLowerCase() ?? '';
}

export function registerTmaHousehold(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  fx: import('../fx/provider').FxProvider,
): void {
  /** Сводка пары; null → household: null (не ошибка — экран просто скрыт). */
  app.get('/api/tma/household', tmaAuth, async (c) => {
    const p = await profile(repoOf(c));
    if (!p) return c.json(notOnboarded().body, 403);
    const user = c.get('tmaUser');
    try {
      const h = await householdSummary(c.env.DB, user.id, fxGet(c, fx));
      return okJson(c, { household: h });
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f.body, f.status as 400);
      throw e;
    }
  });

  /** Лимит общего бюджета (правит любой член); weekly = cap×12/52. */
  app.patch('/api/tma/household', tmaAuth, async (c) => {
    const v = zCap.safeParse(await c.req.json().catch(() => ({})));
    if (!v.success) return c.json(bad('living_cap — число > 0, living_currency — код валюты').body, 400);
    const user = c.get('tmaUser');
    const access = accessRepo(c.env.DB);
    const hh = await access.householdFor(user.id);
    if (!hh) return c.json(err('not_found', 'Нет общего бюджета', 404).body, 404);
    const capMinor = Math.round(v.data.living_cap * 100);
    const weeklyMinor = Math.round((v.data.living_cap * 12 * 100) / 52);
    await access.updateHouseholdCap(hh.id, capMinor, v.data.living_currency, weeklyMinor);
    return okJson(c, { ok: true });
  });

  /**
   * Создать инвайт пары: household создаётся лениво (лимит = личный
   * cap + валюта юзера), код одноразовый, 48 ч. Ответ — ссылка и код
   * для пересылки партнёру (код в тексте — норма: он одноразовый).
   */
  app.post('/api/tma/household/invite', tmaAuth, async (c) => {
    const p = await profile(repoOf(c));
    if (!p) return c.json(notOnboarded().body, 403);
    const user = c.get('tmaUser');
    const access = accessRepo(c.env.DB);
    if (await access.householdFor(user.id)) {
      return c.json(err('conflict', 'Вы уже в общем бюджете', 409).body, 409);
    }
    const nowIso = new Date().toISOString();
    if ((await access.countActiveInvites(user.id, nowIso)) >= 10) {
      return c.json(err('validation', 'Лимит активных приглашений', 400).body, 400);
    }
    const capMinor = p.living_cap_minor ?? 0;
    const weeklyMinor = p.weekly_budget_minor ?? Math.round((capMinor * 12) / 52);
    const hhId = await access.createHousehold(user.id, capMinor, p.living_currency ?? 'USD', weeklyMinor);
    await access.audit('household_created', user.id, { household_id: hhId });
    const code = newInviteCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    await access.createHouseholdInvite(await sha256Hex(`hh_${code}`), user.id, hhId, expiresAt);
    await access.audit('household_invite_created', user.id, { expires_at: expiresAt });
    const link = inviteLink(`hh_${code}`, c.env.TELEGRAM_BOT_USERNAME);
    return okJson(c, { ok: true, code: `hh_${code}`, link });
  });

  /** Вступить по коду (для уже зарегистрированного юзера). */
  app.post('/api/tma/household/join', tmaAuth, async (c) => {
    const v = zJoin.safeParse(await c.req.json().catch(() => ({})));
    if (!v.success) return c.json(bad('code — строка приглашения').body, 400);
    const code = parseInviteCode(v.data.code);
    if (!code) return c.json(bad('Не похоже на код приглашения').body, 400);
    const user = c.get('tmaUser');
    const access = accessRepo(c.env.DB);
    if (await access.householdFor(user.id)) {
      return c.json(err('conflict', 'Вы уже в общем бюджете', 409).body, 409);
    }
    const r = await access.redeemHouseholdInvite(await sha256Hex(`hh_${code}`), user.id, new Date().toISOString());
    if (!r.redeemed) {
      await access.audit('household_join_failed', user.id);
      return c.json(err('validation', 'Приглашение недействительно, истекло или место занято', 400).body, 400);
    }
    await access.audit('household_joined', user.id);
    return okJson(c, { ok: true });
  });

  /** Выйти из пары (общий бюджет удаляется, когда пустеет). */
  app.post('/api/tma/household/leave', tmaAuth, async (c) => {
    const user = c.get('tmaUser');
    const access = accessRepo(c.env.DB);
    const left = await access.leaveHousehold(user.id);
    if (left === null) return c.json(err('not_found', 'Нет общего бюджета', 404).body, 404);
    await access.audit('household_left', user.id);
    return okJson(c, { ok: true });
  });
}
