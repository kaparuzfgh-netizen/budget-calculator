export function isValidBotToken(token: string): boolean;
export function setTomlVar(tomlText: string, key: string, value: string): string;
export function parseSecretList(jsonText: string): Set<string>;
export function pickPrivateSender(
  updates: unknown[] | undefined,
  offset?: number,
): { updateId: number; tgId: number; firstName: string } | null;
export function nextOffset(updates: unknown[] | undefined): number;
export function deriveWorkerUrl(opts: {
  deployOutput?: string;
  workerName?: string | null;
  subdomain?: string | null;
}): string | null;
export function parseWorkerName(tomlText: string): string | null;
export function parseDatabaseId(tomlText: string): string | null;
