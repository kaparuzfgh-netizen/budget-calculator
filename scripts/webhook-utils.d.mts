export function maskUrl(url: string): string;
export function redact(text: string, secrets: (string | undefined)[]): string;
export function parseWebhookUrl(url: string): string;
export function buildSetWebhookPayload(opts: { url: string; secretToken?: string }): {
  url: string;
  allowed_updates: string[];
  drop_pending_updates: boolean;
  secret_token?: string;
};
