/** Vitest setup: тесты дёргают repo напрямую (без fetch-middleware) — настраиваем
 *  DATA_KEY из биндинга один раз на изолят. */
import { env } from 'cloudflare:test';
import { configureDataKey } from '../src/db/crypto';

configureDataKey(env.DATA_KEY as string);
