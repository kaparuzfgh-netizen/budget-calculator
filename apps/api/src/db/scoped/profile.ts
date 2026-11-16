/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow } from '../crypto';
import type { ConsentRow, ProfileRow } from './types';
import type { Ctx } from './ctx';

export function profileRepo({ db, userId, en }: Ctx) {
  return {
    /** Согласия пользователя (vision/экспорт и т.п.). */
    listConsents() {
      return db
        .prepare('SELECT kind, granted, created_at FROM consents WHERE user_id = ? ORDER BY kind')
        .bind(userId)
        .all<ConsentRow>();
    },
    grantConsent(kind: string) {
      return db
        .prepare('INSERT OR REPLACE INTO consents (user_id, kind, granted) VALUES (?, ?, 1)')
        .bind(userId, kind)
        .run();
    },
    hasConsent(kind: string) {
      return db
        .prepare('SELECT granted FROM consents WHERE user_id = ? AND kind = ?')
        .bind(userId, kind)
        .first<{ granted: number }>();
    },
    getProfile() {
      return db.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first<ProfileRow>().then((r) => decRow('profiles', r));
    },
    async upsertProfile(
      p: Omit<
        ProfileRow,
        'user_id' | 'reminders_weekly' | 'reminders_payments' | 'reminders_digest' | 'vision_enabled' | 'fx_alerts_enabled' | 'expense_currency' | 'reminder_hour' | 'cushion_minor'
      > & {
        reminders_weekly?: number;
        reminders_payments?: number;
      },
    ) {
      return db
        .prepare(
          `INSERT INTO profiles (user_id, base_currency, income_currency, living_currency, timezone,
            income_minor, living_cap_minor, weekly_budget_minor, bonus_prepay_share, bonus_dca_share, onboarded_at,
            reminders_weekly, reminders_payments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), COALESCE(?, 1))
           ON CONFLICT(user_id) DO UPDATE SET base_currency=excluded.base_currency,
             income_currency=excluded.income_currency, living_currency=excluded.living_currency,
             timezone=excluded.timezone, income_minor=excluded.income_minor,
             living_cap_minor=excluded.living_cap_minor, weekly_budget_minor=excluded.weekly_budget_minor,
             bonus_prepay_share=excluded.bonus_prepay_share, bonus_dca_share=excluded.bonus_dca_share,
             onboarded_at=excluded.onboarded_at, updated_at=datetime('now')`,
        )
        .bind(
          userId,
          p.base_currency,
          p.income_currency,
          p.living_currency,
          p.timezone,
          await en('profiles', 'income_minor', p.income_minor),
          await en('profiles', 'living_cap_minor', p.living_cap_minor),
          await en('profiles', 'weekly_budget_minor', p.weekly_budget_minor),
          p.bonus_prepay_share,
          p.bonus_dca_share,
          p.onboarded_at,
          p.reminders_weekly ?? null,
          p.reminders_payments ?? null,
        )
        .run();
    },
    /** Точечная правка профиля — whitelist полей, всегда WHERE user_id. */
    async patchProfile(patch: {
      income_minor?: number;
      living_cap_minor?: number;
      weekly_budget_minor?: number;
      income_currency?: string;
      living_currency?: string;
      expense_currency?: string | null;
      timezone?: string;
      reminders_weekly?: number;
      reminders_payments?: number;
      reminders_digest?: number;
      reminder_hour?: number | null;
      vision_enabled?: number;
      fx_alerts_enabled?: number;
      cushion_minor?: number;
      bonus_prepay_share?: number;
      bonus_dca_share?: number;
    }) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      const FIELDS = [
        'income_minor',
        'living_cap_minor',
        'weekly_budget_minor',
        'income_currency',
        'living_currency',
        'expense_currency',
        'timezone',
        'reminders_weekly',
        'reminders_payments',
        'reminders_digest',
        'reminder_hour',
        'vision_enabled',
        'fx_alerts_enabled',
        'cushion_minor',
        'bonus_prepay_share',
        'bonus_dca_share',
      ] as const;
      for (const f of FIELDS) {
        if (patch[f] !== undefined) {
          sets.push(`${f} = ?`);
          binds.push(await en('profiles', f, patch[f]));
        }
      }
      binds.push(userId);
      return db
        .prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = ?`)
        .bind(...binds)
        .run();
    },
  };
}
