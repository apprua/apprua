// Coolify v4 driver (tested with Coolify 4.6). The Coolify token stays on the server: only Apprua uses it.
import { appMiddleware, config, required, type Https } from '../config.js';
import { HttpError } from '../errors.js';
import type { CreateAppInput, DeployResult, Engine, UpdateAppInput } from './types.js';

interface CoolifySettings { url: string; token: string; projectUuid: string; serverUuid: string; environment: string }

function settings(): CoolifySettings {
  return {
    // Not COOLIFY_URL: Coolify injects that variable into every app with the app's own URL
    url: (process.env.COOLIFY_API_URL ?? 'http://coolify:8080').replace(/\/+$/, ''),
    token: required('COOLIFY_TOKEN'),
    projectUuid: required('COOLIFY_PROJECT_UUID'),
    serverUuid: required('COOLIFY_SERVER_UUID'),
    environment: process.env.COOLIFY_ENVIRONMENT ?? 'production',
  };
}

const LABEL_PREFIX = 'apprua';
/** Every app runs without raw network access (NET_RAW): it cannot forge packets on the Docker network to pass for
 *  another container (ARP spoofing) and read what Apprua and the engine say to each other. (Ping still works: Docker
 *  allows it without raw access.) */
export const APP_RUN_OPTIONS = '--cap-drop=NET_RAW';

/** The certificate of the https routers: with the user's own certificate the proxy serves it (no Let's Encrypt, which
 *  cannot reach a local network); with Let's Encrypt every https router asks for one. */
export function tlsLabels(lines: string[], https: Https): string[] {
  const resolver = /^traefik\.http\.routers\.([^.]+)\.tls\.certresolver=/;
  if (https === 'own') return lines.filter((l) => !resolver.test(l));
  if (https !== 'letsencrypt') return lines;
  const out = [...lines];
  for (const l of lines) {
    const m = /^traefik\.http\.routers\.([^.]+)\.tls=true$/.exec(l);
    if (m && !lines.some((x) => x.startsWith(`traefik.http.routers.${m[1]}.tls.certresolver=`)))
      out.push(`traefik.http.routers.${m[1]}.tls.certresolver=letsencrypt`);
  }
  return out;
}


export class CoolifyEngine implements Engine {
  readonly name = 'coolify';
  private s?: CoolifySettings;
  private get cfg() { return (this.s ??= settings()); }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new HttpError(502, `The engine (Coolify at ${this.cfg.url}) is not reachable: ${(e as any)?.cause?.code ?? (e as Error).message}`);
    }
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = { message: text.slice(0, 300) }; }
    if (!res.ok) throw new HttpError(502, `Coolify ${method} ${path.split('?')[0]} failed (${res.status}): ${data?.message ?? text}`, data?.errors);
    return data as T;
  }

  async check(): Promise<string> {
    const v = await this.call<unknown>('GET', '/version');
    await this.call('GET', `/projects/${this.cfg.projectUuid}`);
    // Coolify answers either "4.6.0" or {"message":"4.6.0"} depending on the version
    const ver = typeof v === 'string' ? v : (v as { message?: string; version?: string } | null)?.message ?? (v as { version?: string } | null)?.version ?? '';
    return `Coolify ${ver}`.trim();
  }

  async createApp(i: CreateAppInput): Promise<string> {
    const r = await this.call<{ uuid: string }>('POST', '/applications/public', {
      project_uuid: this.cfg.projectUuid,
      server_uuid: this.cfg.serverUuid,
      environment_name: this.cfg.environment,
      git_repository: i.gitUrl,
      git_branch: 'main',
      build_pack: i.buildPack,
      ports_exposes: String(i.port),
      domains: i.url,
      name: i.name,
      description: i.description.slice(0, 250),
      limits_cpus: i.cpus,
      limits_memory: i.memory,
      is_auto_deploy_enabled: false,
      instant_deploy: false,
      custom_docker_run_options: APP_RUN_OPTIONS,
    });
    return r.uuid;
  }

  async updateApp(id: string, i: UpdateAppInput): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (i.buildPack) fields.build_pack = i.buildPack;
    if (i.port) fields.ports_exposes = String(i.port);
    if (i.description) fields.description = i.description.slice(0, 250);
    if (i.cpus) fields.limits_cpus = i.cpus;
    if (i.memory) fields.limits_memory = i.memory;
    if (Object.keys(fields).length) await this.call('PATCH', `/applications/${id}`, fields);
  }

  async deleteApp(id: string): Promise<void> {
    await this.call('DELETE', `/applications/${id}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`);
  }

  async setUrl(id: string, url: string): Promise<void> {
    // Coolify rewrites its routing labels for the new address (dropping ours: the caller applies them again)
    await this.call('PATCH', `/applications/${id}`, { domains: url });
  }

  async start(id: string) { await this.call('POST', `/applications/${id}/start`); }
  async stop(id: string) { await this.call('POST', `/applications/${id}/stop`); }
  async restart(id: string) { await this.call('POST', `/applications/${id}/restart`); }

  async addPersistentStorage(id: string, volumeName: string) {
    await this.call('POST', `/applications/${id}/storages`, { type: 'persistent', name: volumeName, mount_path: '/data' });
  }

  async setEnv(id: string, key: string, value: string) {
    const envs = await this.call<any[]>('GET', `/applications/${id}/envs`);
    const body = { key, value, is_literal: true, is_shown_once: true, is_preview: false };
    if (envs.some((e) => e.key === key)) await this.call('PATCH', `/applications/${id}/envs`, body);
    else await this.call('POST', `/applications/${id}/envs`, body);
  }

  async listEnv(id: string): Promise<string[]> {
    const envs = await this.call<any[]>('GET', `/applications/${id}/envs`);
    return [...new Set(envs.filter((e) => !e.is_preview).map((e) => String(e.key)))].sort();
  }

  async deleteEnv(id: string, key: string): Promise<void> {
    const envs = await this.call<any[]>('GET', `/applications/${id}/envs`);
    for (const e of envs.filter((x) => x.key === key)) await this.call('DELETE', `/applications/${id}/envs/${e.uuid}`);
  }

  async runtimeStatus(id: string): Promise<string | null> {
    return (await this.call('GET', `/applications/${id}`).catch(() => null))?.status ?? null;
  }

  async runtimeLogs(id: string, lines: number): Promise<string[]> {
    const r = await this.call<{ logs: string }>('GET', `/applications/${id}/logs?lines=${lines}`);
    return String(r.logs ?? '').split('\n');
  }

  /** Adds owner/app labels and puts the login in front of the app (Apprua's gate, or APP_AUTH_MIDDLEWARE). */
  async applyLabels(id: string, appName: string, owner: string): Promise<void> {
    const app = await this.call('GET', `/applications/${id}`);
    let raw: string = app.custom_labels ?? '';
    if (!raw) throw new HttpError(502, 'Coolify did not return the generated labels (the API token needs the read:sensitive permission).');
    if (!raw.includes('traefik.') && !raw.includes('caddy')) raw = Buffer.from(raw, 'base64').toString('utf8');
    let out = raw.split('\n').filter((l) => l && !l.startsWith(`${LABEL_PREFIX}.`));
    const mw = appMiddleware();
    if (mw) {
      out = out.map((l) => {
        const m = /^(traefik\.http\.routers\.https?-[^.]+\.middlewares)=(.*)$/.exec(l);
        if (!m) return l;
        const mws = m[2].split(',').filter((x) => x && x !== mw);
        return `${m[1]}=${[mw, ...mws].join(',')}`;
      });
      for (const router of new Set(out.map((l) => /^traefik\.http\.routers\.(https?-[^.]+)\.rule=/.exec(l)?.[1]).filter(Boolean) as string[])) {
        if (!out.some((l) => l.startsWith(`traefik.http.routers.${router}.middlewares=`)))
          out.push(`traefik.http.routers.${router}.middlewares=${mw}`);
      }
    }
    out = tlsLabels(out, config.https);
    out.push(`${LABEL_PREFIX}.app=${appName}`, `${LABEL_PREFIX}.owner=${owner}`);
    await this.call('PATCH', `/applications/${id}`, { custom_labels: Buffer.from(out.join('\n')).toString('base64'), custom_docker_run_options: APP_RUN_OPTIONS });
  }

  async deploy(id: string): Promise<string> {
    const r = await this.call<{ deployments: { deployment_uuid: string }[] }>('POST', `/deploy?uuid=${id}&force=false`);
    const d = r.deployments?.[0]?.deployment_uuid;
    if (!d) throw new HttpError(502, 'Coolify did not start a deployment.');
    return d;
  }

  async findDeployment(id: string, sinceIso: string, known: string[]): Promise<string | null> {
    // newest first; a few seconds of margin for the clocks of Apprua and of the engine
    const r = await this.call<{ deployments?: { deployment_uuid: string; created_at: string }[] }>('GET', `/deployments/applications/${id}?skip=0&take=5`);
    const since = Date.parse(sinceIso) - 10_000;
    const d = (r.deployments ?? []).find((x) => Date.parse(x.created_at) >= since && !known.includes(x.deployment_uuid));
    return d?.deployment_uuid ?? null;
  }

  async waitDeployment(deploymentId: string, timeoutMs: number): Promise<DeployResult> {
    const start = Date.now();
    const end = start + timeoutMs;
    let d: any;
    for (;;) {
      d = await this.call('GET', `/deployments/${deploymentId}`);
      // Coolify, while it starts (just after the PC or the Linux starts), marks the deployments it finds in progress as
      // "failed" without a single line of log, then runs them anyway and they finish (seen on a test PC). A real
      // failure always has a log: an empty "failed" in the first 2 minutes is waited out.
      const emptyFail = d.status === 'failed' && !hasLogs(d.logs) && Date.now() - start < 120_000;
      if ((['finished', 'failed', 'cancelled-by-user'].includes(d.status) && !emptyFail) || Date.now() >= end) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const status = d?.status === 'finished' ? 'finished' : ['failed', 'cancelled-by-user'].includes(d?.status) ? 'failed' : 'timeout';
    let entries: { output: string; hidden?: boolean }[] = [];
    try { entries = typeof d?.logs === 'string' ? JSON.parse(d.logs) : d?.logs ?? []; } catch { /* no logs */ }
    const logTail = entries.filter((e) => !e.hidden).flatMap((e) => String(e.output).split('\n')).filter(Boolean)
      .map(hideSecrets).slice(-50);
    return { status, logTail };
  }
}

/** Whether a Coolify deployment has at least one line of log (its logs are a JSON array, sometimes as a string). */
function hasLogs(logs: unknown): boolean {
  try {
    const a = typeof logs === 'string' ? JSON.parse(logs) : logs;
    return Array.isArray(a) && a.some((e) => String(e?.output ?? '').trim());
  } catch { return false; }
}

/** The git URL contains the per-app read key: never show it in logs returned to users. */
const hideSecrets = (line: string) => line.replace(/(\/git\/)[A-Za-z0-9_-]{16,}\//g, '$1…/');
