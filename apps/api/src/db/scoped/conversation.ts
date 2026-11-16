/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decStr } from '../crypto';
import type { Ctx } from './ctx';

export function conversationRepo({ db, userId, en }: Ctx) {
  return {
    getConversation() {
      return db
        .prepare('SELECT step, data, updated_at FROM conversation_state WHERE user_id = ?')
        .bind(userId)
        .first<{ step: string; data: string; updated_at: string }>()
        .then(async (r) => {
          if (r?.data) r.data = (await decStr(userId, 'conversation_state', 'data', r.data))!;
          return r;
        });
    },
    async setConversation(step: string, data: string) {
      return db
        .prepare(
          `INSERT INTO conversation_state (user_id, step, data) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET step=excluded.step, data=excluded.data, updated_at=datetime('now')`,
        )
        .bind(userId, step, await en('conversation_state', 'data', data))
        .run();
    },
    /**
     * CAS-запись: обновляет только если текущий step === expected.
     * meta.changes === 0 → состояние изменил другой апдейт → проигравший молчит.
     */
    async setConversationExpected(step: string, data: string, expected: string) {
      return db
        .prepare(
          `UPDATE conversation_state SET step = ?, data = ?, updated_at = datetime('now')
           WHERE user_id = ? AND step = ?`,
        )
        .bind(step, await en('conversation_state', 'data', data), userId, expected)
        .run();
    },
    clearConversation() {
      return db.prepare('DELETE FROM conversation_state WHERE user_id = ?').bind(userId).run();
    },
    /** CAS-очистка: удаляет только если step === expected. */
    clearConversationExpected(expected: string) {
      return db.prepare('DELETE FROM conversation_state WHERE user_id = ? AND step = ?').bind(userId, expected).run();
    },
  };
}
