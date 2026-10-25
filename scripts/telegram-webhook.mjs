#!/usr/bin/env node
/**
 * telegram-webhook.mjs — регистрация вебхука бота в Telegram.
 *
 *   node scripts/telegram-webhook.mjs set <https-url>   — setWebhook
 *   node scripts/telegram-webhook.mjs info            — getWebhookInfo (URL замаскирован)
 *   node scripts/telegram-webhook.mjs delete          — deleteWebhook
 *
 * TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET берутся из env; если их нет —
 * спрашиваются интерактивно со СКРЫТЫМ вводом (без эха). Значения никогда
 * не печатаются, не пишутся на диск и не попадают в историю шелла.
 */
import readline from 'node:readline';
import { buildSetWebhookPayload, maskUrl, redact } from './webhook-utils.mjs';

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (rl.stdoutMuted) rl.output.write('*');
      else orig(s);
    };
    rl.stdoutMuted = true;
    rl.question(question, (answer) => {
      rl.stdoutMuted = false;
      rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    rl.on('error', reject);
  });
}

async function tgCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`Telegram API ${method}: HTTP ${res.status} (не-JSON ответ)`);
  }
  if (!res.ok || !j.ok) {
    throw new Error(`Telegram API ${method}: ${j.description ?? res.status}`);
  }
  return j.result;
}

async function main() {
  const [, , cmd, urlArg] = process.argv;
  if (!['set', 'info', 'delete'].includes(cmd)) {
    console.error('Использование: telegram-webhook.mjs set <https-url> | info | delete');
    process.exit(2);
  }

  let token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  let secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!token) token = await askHidden('TELEGRAM_BOT_TOKEN (скрытый ввод): ');
  if (cmd === 'set' && !secret) {
    secret = await askHidden('TELEGRAM_WEBHOOK_SECRET (тот же, что в wrangler secret): ');
  }

  try {
    if (cmd === 'set') {
      if (!urlArg) throw new Error('нужен аргумент: https-URL вебхука');
      const payload = buildSetWebhookPayload({ url: urlArg, secretToken: secret });
      await tgCall(token, 'setWebhook', payload);
      console.log(`✅ Вебхук установлен: ${maskUrl(payload.url)} (только message-апдейты)`);
    } else if (cmd === 'info') {
      const i = await tgCall(token, 'getWebhookInfo');
      console.log(`url: ${i.url ? maskUrl(i.url) : '(не задан)'}`);
      console.log(`pending: ${i.pending_update_count ?? 0}, last_error: ${i.last_error_message ?? '—'}`);
    } else {
      await tgCall(token, 'deleteWebhook', { drop_pending_updates: true });
      console.log('✅ Вебхук удалён');
    }
  } catch (e) {
    console.error(`Ошибка: ${redact(e instanceof Error ? e.message : String(e), [token, secret])}`);
    process.exit(1);
  }
}

main();
