/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import type { Ctx } from './ctx';

export function remindersRepo({ db, userId }: Ctx) {
  return {
    claimReminder(kind: string, key: string) {
      return db
        .prepare('INSERT OR IGNORE INTO reminder_log (user_id, kind, key) VALUES (?, ?, ?)')
        .bind(userId, kind, key)
        .run();
    },
    releaseReminder(kind: string, key: string) {
      return db
        .prepare('DELETE FROM reminder_log WHERE user_id = ? AND kind = ? AND key = ?')
        .bind(userId, kind, key)
        .run();
    },
    /**
     * Дневной лимит vision-скриншотов (A2-9): занятые слоты — одним SELECT,
     * свободный — одним claim (ключ '<YYYY-MM-DD>:<n>', n = 1..limit).
     * Было: до `limit` INSERT подряд на запрос. true — слот наш.
     */
    async claimVisionSlot(dayIso: string, limit: number): Promise<boolean> {
      const taken = await db
        .prepare("SELECT key FROM reminder_log WHERE user_id = ? AND kind = 'vision' AND key LIKE ?")
        .bind(userId, `${dayIso}:%`)
        .all<{ key: string }>();
      const used = new Set(taken.results.map((r) => r.key));
      for (let n = 1; n <= limit; n++) {
        if (used.has(`${dayIso}:${n}`)) continue;
        const r = await db
          .prepare("INSERT OR IGNORE INTO reminder_log (user_id, kind, key) VALUES (?, 'vision', ?)")
          .bind(userId, `${dayIso}:${n}`)
          .run();
        if (r.meta.changes === 1) return true;
        used.add(`${dayIso}:${n}`); // гонка: слот занял другой запрос — следующий
      }
      return false;
    },
  };
}
