/**
 * setup-utils.test.ts — чистые хелперы мастера `npm run setup`.
 * Выполняются в workerd-сюите вместе с остальными тестами API.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveWorkerUrl,
  envSection,
  isValidBotToken,
  nextOffset,
  parseDatabaseId,
  parseSecretList,
  parseWorkerName,
  pickPrivateSender,
  setTomlVar,
} from '../../../scripts/setup-utils.mjs';
import { redact } from '../../../scripts/webhook-utils.mjs';

const FAKE_TOKEN = ['123456789', 'A'.repeat(35)].join(':');

describe('isValidBotToken', () => {
  it('принимает формат BotFather, отклоняет мусор', () => {
    expect(isValidBotToken(FAKE_TOKEN)).toBe(true);
    expect(isValidBotToken(` ${FAKE_TOKEN} `)).toBe(true);
    expect(isValidBotToken('12345:short')).toBe(false);
    expect(isValidBotToken('notatoken')).toBe(false);
    expect(isValidBotToken('')).toBe(false);
  });
});

describe('setTomlVar', () => {
  const base = 'name = "api"\n\n[vars]\nFOO = "1"\nBAR = "2"\n\n[d1_databases]\nbinding = "DB"\n';

  it('обновляет существующий ключ в [vars]', () => {
    const out = setTomlVar(base, 'FOO', '9');
    expect(out).toContain('FOO = "9"');
    expect(out).toContain('BAR = "2"');
    expect(out).toContain('[d1_databases]');
  });

  it('добавляет ключ в существующую секцию [vars]', () => {
    const out = setTomlVar(base, 'NEW_KEY', 'x');
    const varsIdx = out.indexOf('[vars]');
    const keyIdx = out.indexOf('NEW_KEY = "x"');
    expect(keyIdx).toBeGreaterThan(varsIdx);
    expect(keyIdx).toBeLessThan(out.indexOf('[d1_databases]'));
  });

  it('создаёт [vars] в конце файла без секции', () => {
    const out = setTomlVar('name = "api"\nworkers_dev = true\n', 'K', 'v');
    expect(out).toMatch(/\[vars\]\nK = "v"/);
    expect(out).toContain('workers_dev = true');
  });

  it('сохраняет CRLF-переводы строк', () => {
    const crlf = 'name = "api"\r\n\r\n[vars]\r\nFOO = "1"\r\n';
    const out = setTomlVar(crlf, 'NEW', 'z');
    expect(out).toContain('NEW = "z"\r\n'); // вставленная строка тоже CRLF
    expect(out.replace(/\r\n/g, '')).not.toContain('\n'); // ни одной «голой» LF
  });

  it('не трогает ключи в других секциях', () => {
    const t = 'name = "api"\n\n[other]\nFOO = "old"\n\n[vars]\nBAR = "1"\n';
    const out = setTomlVar(t, 'FOO', 'new');
    // FOO в [other] не меняется — в [vars] добавляется новый
    expect(out).toContain('[other]\nFOO = "old"');
    expect(out.indexOf('FOO = "new"')).toBeGreaterThan(out.indexOf('[vars]'));
  });

  it('env-режим: пишет в [env.staging.vars], верхний [vars] не трогает', () => {
    const t =
      'name = "api"\n\n[vars]\nTELEGRAM_BOT_USERNAME = "prod_bot"\n\n' +
      '[env.staging]\nname = "api-staging"\n\n' +
      '[[env.staging.d1_databases]]\ndatabase_id = "x"\n\n' +
      '[env.staging.vars]\nTELEGRAM_BOT_USERNAME = "pending"\n';
    const out = setTomlVar(t, 'TELEGRAM_BOT_USERNAME', 'stage_bot', 'env.staging.vars');
    expect(out).toContain('TELEGRAM_BOT_USERNAME = "stage_bot"');
    expect(out).toContain('[vars]\nTELEGRAM_BOT_USERNAME = "prod_bot"'); // прод-username цел
    expect(out).toContain('database_id = "x"');
  });
});

describe('envSection', () => {
  const toml =
    'name = "api"\n\n[vars]\nMINI_APP_URL = "https://prod"\n\n' +
    '[env.staging]\nname = "api-staging"\n\n' +
    '[[env.staging.d1_databases]]\ndatabase_id = "st-1"\n\n' +
    '[env.staging.triggers]\ncrons = []\n\n' +
    '[env.staging.vars]\nMINI_APP_URL = "https://stage"\n';

  it('режет блок [env.<name>] с подтаблицами до следующего чужого top-level', () => {
    const s = envSection(toml, 'staging');
    expect(s).toContain('name = "api-staging"');
    expect(s).toContain('database_id = "st-1"');
    expect(s).toContain('MINI_APP_URL = "https://stage"');
    expect(s).not.toContain('"api"'); // верхний name не попал
    expect(s).not.toContain('https://prod');
    // парсеры работают по срезу как по целому файлу
    expect(parseWorkerName(s)).toBe('api-staging');
    expect(parseDatabaseId(s)).toBe('st-1');
  });

  it('env-блок не обязан быть последним: обрезает по чужому top-level заголовку', () => {
    const t = envSection(toml + '\n[env.prod]\nname = "api-prod"\n', 'staging');
    expect(t).toContain('api-staging');
    expect(t).not.toContain('api-prod');
  });

  it('нет такого env → пустая строка', () => {
    expect(envSection(toml, 'qa')).toBe('');
  });
});

describe('parseSecretList', () => {
  it('парсит JSON-массив wrangler secret list', () => {
    const s = parseSecretList('[{"name":"A"},{"name":"B"}]');
    expect(s.has('A')).toBe(true);
    expect(s.has('B')).toBe(true);
    expect(s.has('C')).toBe(false);
  });
  it('терпит мусор вокруг JSON и невалидный ввод', () => {
    expect(parseSecretList('warn\n[{"name":"X"}]\ndone').has('X')).toBe(true);
    expect(parseSecretList('not json').size).toBe(0);
    expect(parseSecretList('').size).toBe(0);
  });
});

describe('pickPrivateSender / nextOffset', () => {
  const updates = [
    { update_id: 10, message: { chat: { id: 1, type: 'group' }, from: { id: 111 } } },
    { update_id: 11, message: { chat: { id: 2, type: 'private' }, from: { id: 222, first_name: 'Ann' } } },
    { update_id: 12, message: { chat: { id: 3, type: 'private' }, from: { id: 333, first_name: 'Bob' } } },
    { update_id: 13, edited_message: { chat: { type: 'private' }, from: { id: 444 } } },
  ];
  it('берёт первое личное сообщение новее offset', () => {
    expect(pickPrivateSender(updates, 0)).toEqual({ updateId: 11, tgId: 222, firstName: 'Ann' });
    expect(pickPrivateSender(updates, 11)).toEqual({ updateId: 12, tgId: 333, firstName: 'Bob' });
    expect(pickPrivateSender(updates, 12)).toBeNull();
    expect(pickPrivateSender(undefined, 0)).toBeNull();
  });
  it('nextOffset = max update_id + 1', () => {
    expect(nextOffset(updates)).toBe(14);
    expect(nextOffset([])).toBe(0);
  });
});

describe('deriveWorkerUrl / toml-парсинг', () => {
  it('извлекает URL из вывода wrangler deploy', () => {
    const out =
      'Uploaded budget-companion-api (x sec)\n https://budget-companion-api.fool-undef.workers.dev\nCurrent Deployment ID: abc';
    expect(deriveWorkerUrl({ deployOutput: out })).toBe('https://budget-companion-api.fool-undef.workers.dev');
  });
  it('собирает из name+subdomain, иначе null', () => {
    expect(deriveWorkerUrl({ workerName: 'api', subdomain: 'acc' })).toBe('https://api.acc.workers.dev');
    expect(deriveWorkerUrl({})).toBeNull();
  });
  it('parseWorkerName / parseDatabaseId', () => {
    const t = 'name = "budget-companion-api"\ndatabase_id = "d886f0a1-dead"';
    expect(parseWorkerName(t)).toBe('budget-companion-api');
    expect(parseDatabaseId(t)).toBe('d886f0a1-dead');
    expect(parseDatabaseId('x = 1')).toBeNull();
  });
});

describe('redact (повторно, из webhook-utils)', () => {
  it('маскирует токен в тексте ошибки', () => {
    const tok = FAKE_TOKEN;
    expect(redact(`fail https://api.telegram.org/bot${tok}/sendMessage`, [tok])).toBe(
      'fail https://api.telegram.org/bot***/sendMessage',
    );
  });
});
