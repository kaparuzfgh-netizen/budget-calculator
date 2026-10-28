/**
 * setup-utils.mjs — чистые хелперы scripts/setup.mjs.
 * Никаких node:* импортов — файл тестируется в workerd-сюите.
 */

/** Формат токена BotFather: <digits>:<30+ url-safe chars>. */
export function isValidBotToken(token) {
  return typeof token === 'string' && /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/**
 * Записать/обновить ключ в [vars] wrangler.toml.
 * Сохраняет остальной файл и стиль переводов строк (CRLF/LF);
 * создаёт секцию [vars] в конце, если её нет.
 */
export function setTomlVar(tomlText, key, value) {
  const nl = tomlText.includes('\r\n') ? '\r\n' : '\n';
  const lines = tomlText.split(/\r?\n/);
  const entry = `${key} = ${JSON.stringify(value)}`;

  // границы секции [vars]
  let varsStart = -1;
  let varsEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\[vars\]\s*$/.test(t)) varsStart = i;
    else if (varsStart >= 0 && /^\[/.test(t) && !/^\[\[/.test(t)) {
      varsEnd = i;
      break;
    }
  }

  if (varsStart === -1) {
    // секции нет — добавляем в конец
    const out = [...lines];
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('[vars]', entry);
    return out.join(nl);
  }
  // ключ уже есть в [vars] — заменяем
  for (let i = varsStart + 1; i < varsEnd; i++) {
    const t = lines[i].trim();
    if (t.startsWith(`${key} =`) || t.startsWith(`${key}=`)) {
      const indent = lines[i].match(/^\s*/)[0];
      lines[i] = indent + entry;
      return lines.join(nl);
    }
  }
  // ключа нет — вставляем сразу после заголовка секции
  lines.splice(varsStart + 1, 0, entry);
  return lines.join(nl);
}

/** wrangler secret list --format json → множество имён. Терпимо к мусору в выводе. */
export function parseSecretList(jsonText) {
  const start = jsonText.indexOf('[');
  const end = jsonText.lastIndexOf(']');
  if (start === -1 || end === -1) return new Set();
  try {
    const arr = JSON.parse(jsonText.slice(start, end + 1));
    return new Set(arr.map((s) => s?.name ?? s).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * getUpdates result[] → первое ЛИЧНОЕ сообщение (chat.type 'private')
 * с from.id и update_id > offset. Возвращает {updateId, tgId, firstName} | null.
 */
export function pickPrivateSender(updates, offset = 0) {
  for (const u of updates ?? []) {
    const m = u?.message;
    if (!m || u.update_id == null || u.update_id <= offset) continue;
    if (m.chat?.type !== 'private' || typeof m.from?.id !== 'number') continue;
    return { updateId: u.update_id, tgId: m.from.id, firstName: m.from.first_name ?? '' };
  }
  return null;
}

/** Максимальный update_id + 1 — ack через offset, чтобы апдейты не реплеились. */
export function nextOffset(updates) {
  let max = -1;
  for (const u of updates ?? []) if (typeof u?.update_id === 'number' && u.update_id > max) max = u.update_id;
  return max + 1;
}

/**
 * URL воркера: парсинг из вывода `wrangler deploy`
 * (https://<name>.<sub>.workers.dev) или сборка из name + subdomain.
 */
export function deriveWorkerUrl({ deployOutput, workerName, subdomain }) {
  const m = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(deployOutput ?? '');
  if (m) return m[0];
  if (workerName && subdomain) return `https://${workerName}.${subdomain}.workers.dev`;
  return null;
}

/** Имя воркера из wrangler.toml (name = "..."). */
export function parseWorkerName(tomlText) {
  const m = /^name\s*=\s*"([^"]+)"/m.exec(tomlText);
  return m ? m[1] : null;
}

/** database_id из wrangler.toml — для проверки placeholder. */
export function parseDatabaseId(tomlText) {
  const m = /^database_id\s*=\s*"([^"]+)"/m.exec(tomlText);
  return m ? m[1] : null;
}

/** Строковая переменная из wrangler.toml (name = "value"); null — не задана. */
export function getTomlVar(tomlText, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(tomlText);
  return m ? m[1] : null;
}
