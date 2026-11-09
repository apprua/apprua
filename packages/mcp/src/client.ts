// HTTP client for the Apprua server (personal token).
import { readFileSync } from 'node:fs';

export const BASE_URL = (process.env.APPRUA_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.APPRUA_TOKEN ?? '';
// Without HTTPS, past this computer, the key travels unencrypted: said in the AI app's log (stdout is the MCP channel)
if (/^http:\/\//i.test(BASE_URL) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?(\/|$)/i.test(BASE_URL))
  console.error(`Apprua: ${BASE_URL} has no HTTPS, so the personal key travels unencrypted on the network.`);

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

function notConfigured(): never {
  throw new ApiError(0, 'The Apprua connector is not configured: set APPRUA_URL (address of your Apprua portal) and APPRUA_TOKEN (create it in the portal).');
}

async function request(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
  if (!BASE_URL || !TOKEN) notConfigured();
  const isForm = body instanceof FormData;
  try {
    return await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const cause = (e as any)?.cause?.code ?? (e as Error).message;
    const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(cause))
      ? ' The HTTPS certificate is not trusted on this PC (for a private certificate authority set NODE_EXTRA_CA_CERTS).'
      : ' Is Apprua running, and is this PC able to reach it?';
    throw new ApiError(0, `Cannot reach ${BASE_URL} (${cause}).${hint}`);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await request(method, path, body, timeoutMs);
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data?.details);
  return data as T;
}

/** Downloads a binary response (e.g. the app's code). */
export async function download(path: string): Promise<{ data: Buffer; headers: Headers }> {
  const res = await request('GET', path, undefined, 5 * 60_000);
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(text).error ?? msg; } catch { /* keep status */ }
    throw new ApiError(res.status, msg);
  }
  return { data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

export async function uploadArchive(path: string, archive: string, fields: Record<string, string | undefined>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') form.append(k, v);
  form.append('archive', new Blob([readFileSync(archive)], { type: 'application/gzip' }), 'app.tar.gz');
  return api('POST', path, form, 15 * 60_000);
}
