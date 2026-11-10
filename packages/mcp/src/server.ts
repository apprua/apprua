#!/usr/bin/env node
// Apprua connector: an MCP server (stdio) that runs on the user's PC and lets any MCP-capable AI app
// (Claude Desktop, Claude Code, Cursor, VS Code, ...) publish and manage apps on a Apprua server.
// Config: APPRUA_URL (portal address), APPRUA_TOKEN (personal token from the portal).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as tar from 'tar';
import { z } from 'zod';
import { api, ApiError, download, uploadArchive } from './client.js';
import { APP_NAME_RE, packFolder, readState, STATE_FILE } from './pack.js';

const BRAND = process.env.APPRUA_BRAND ?? 'Apprua';
declare const __APPRUA_VERSION__: string;   // written by build.mjs from package.json
const server = new McpServer({ name: 'apprua', version: __APPRUA_VERSION__ });

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): Content => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Content => ({ content: [{ type: 'text', text }], isError: true });
const json = (v: unknown) => JSON.stringify(v, null, 2);

async function run(fn: () => Promise<Content>): Promise<Content> {
  try { return await fn(); } catch (e) {
    if (e instanceof ApiError) return fail(`${e.message}${e.details ? `\nDetails: ${json(e.details)}` : ''}`);
    return fail(`Error: ${(e as Error).message}`);
  }
}

const appName = z.string().regex(APP_NAME_RE).describe('App name = sub-domain, e.g. "my-notes" (lowercase letters, digits, dashes)');
const saveState = (dir: string, r: { app: string; url: string; commit: string }) => {
  if (r.commit) writeFileSync(join(dir, STATE_FILE), json({ app: r.app, url: r.url, commit: r.commit }));
};

function describePublish(r: any, pack?: { files: number; bytes: number; skippedLarge: string[] }): Content {
  const lines = [
    r.status === 'running' ? `✅ ${r.app} is online: ${r.url}` : `❌ Deploy of ${r.app} ${r.status}. Build log (last lines):\n${(r.logTail ?? []).join('\n')}`,
    pack ? `Uploaded ${pack.files} files (${Math.round(pack.bytes / 1024)} KB).` : '',
    pack?.skippedLarge.length ? `Skipped files over 20 MB: ${pack.skippedLarge.join(', ')}` : '',
    r.warnings?.length ? `⚠️ Warnings (the app may not work outside the AI chat):\n- ${r.warnings.join('\n- ')}` : '',
    r.status !== 'running' ? 'Read the log, propose a fix to the user, then call update_app.' : 'Tell the user the URL.',
  ];
  return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }], isError: r.status !== 'running' };
}

server.registerTool('publish_app', {
  title: 'Publish a new app',
  description: `Packs a local folder and publishes it as a NEW app on ${BRAND}, the user's own app server ` +
    `("publish on ${BRAND}" / "pubblica su ${BRAND}" means this tool; the app gets its own address, https://<name>.<domain> or http://<name>.localhost). ` +
    'BEFORE calling: confirm with the user the app name, a one-line description, and whether the app saves data (persistent=true keeps /data across deploys). ' +
    'Never put secrets (API keys, passwords) in the files: use set_env after publishing. Supported: a Dockerfile, a Node/Python/... project, or a static folder with index.html. ' +
    'After success, give the user the URL. On failure read the log, propose a fix, and use update_app.',
  inputSchema: {
    path: z.string().describe('Absolute path of the local folder to publish (on this PC). If the user says "this project", use the root folder of the project you are working on'),
    name: appName,
    description: z.string().min(5).max(250).describe('What the app does, one sentence'),
    persistent: z.boolean().default(false).describe('true if the app stores data (files/SQLite) in /data that must survive restarts and new versions'),
    port: z.number().int().min(1).max(65535).optional().describe('Port the app listens on, if not obvious (static sites: omit)'),
  },
  annotations: { destructiveHint: false, openWorldHint: true },
}, async ({ path, name, description, persistent, port }) => run(async () => {
  const dir = resolve(path);
  const pack = await packFolder(dir);
  try {
    const r = await uploadArchive('/v1/apps', pack.archive, { name, description, persistent: String(persistent), port: port ? String(port) : undefined });
    saveState(dir, r);
    return describePublish(r, pack);
  } finally { rmSync(dirname(pack.archive), { recursive: true, force: true }); }
}));

server.registerTool('update_app', {
  title: 'Publish a new version',
  description: 'Publishes a new version of an EXISTING app of the user from a local folder. If the app was changed in the meantime from another copy, ' +
    'it refuses instead of overwriting: then use clone_app to get the latest version, apply the changes there and retry.',
  inputSchema: {
    path: z.string().describe('Absolute path of the local folder (on this PC); for "this project" use the root of the current project'),
    name: appName.optional().describe('App name (optional if the folder was published or cloned before)'),
    port: z.number().int().min(1).max(65535).optional(),
  },
  annotations: { destructiveHint: false, openWorldHint: true },
}, async ({ path, name, port }) => run(async () => {
  const dir = resolve(path);
  const state = readState(dir);
  // a state file without a commit was not written by this connector (it could come with a downloaded template)
  const target = name ?? (state.commit ? state.app : undefined);
  if (!target) return fail('Which app? Pass "name" (this folder was not published or cloned from this PC before).');
  const pack = await packFolder(dir);
  try {
    const r = await uploadArchive(`/v1/apps/${target}/deploy`, pack.archive, {
      base_commit: state.app === target ? state.commit : undefined, port: port ? String(port) : undefined,
    });
    saveState(dir, r);
    return describePublish(r, pack);
  } finally { rmSync(dirname(pack.archive), { recursive: true, force: true }); }
}));

server.registerTool('list_my_apps', {
  title: 'My apps', description: `Lists the user's apps on ${BRAND} with status and URL.`,
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => run(async () => ok(json(await api('GET', '/v1/apps')))));

server.registerTool('app_status', {
  title: 'App status', description: 'Status, URL, limits, last deploy and recent versions of one of the user\'s apps.',
  inputSchema: { name: appName }, annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ name }) => run(async () => ok(json(await api('GET', `/v1/apps/${name}`)))));

server.registerTool('app_logs', {
  title: 'App logs', description: 'Last log lines of an app: type "runtime" (the running app) or "build" (last deploy). Use it to diagnose errors and propose fixes.',
  inputSchema: { name: appName, type: z.enum(['runtime', 'build']).default('runtime'), lines: z.number().int().min(10).max(1000).default(100) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ name, type, lines }) => run(async () => {
  const r = await api('GET', `/v1/apps/${name}/logs?type=${type}&lines=${lines}`);
  return ok(`${type} log of ${name}:\n${(r.lines ?? []).join('\n') || '(empty)'}`);
}));

for (const [tool, action, title, destructive] of [
  ['restart_app', 'restart', 'Restart app', false], ['start_app', 'start', 'Start app', false], ['stop_app', 'stop', 'Stop app', true],
] as const) {
  server.registerTool(tool, {
    title, description: `${title} (only apps owned by the user).${destructive ? ' The app stays offline until start_app. Confirm with the user first.' : ''}`,
    inputSchema: { name: appName }, annotations: { destructiveHint: destructive, idempotentHint: true, openWorldHint: true },
  }, async ({ name }) => run(async () => ok(json(await api('POST', `/v1/apps/${name}/${action}`)))));
}

server.registerTool('set_env', {
  title: 'Set an environment variable or secret',
  description: 'Sets an environment variable / secret of the app (e.g. an API key or a database password) and restarts it. The value is stored on the server, never in the code, and is never shown back. ' +
    'Ask the user for the value; do not write it in any file.',
  inputSchema: { name: appName, key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).describe('UPPER_CASE name, e.g. OPENAI_API_KEY'), value: z.string(), restart: z.boolean().default(true) },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ name, key, value, restart }) => run(async () => {
  await api('PUT', `/v1/apps/${name}/env`, { key, value, restart });
  return ok(`${key} set on ${name}${restart ? ' and the app was restarted' : ' (restart the app to apply)'}. The value is not stored anywhere else.`);
}));

server.registerTool('unset_env', {
  title: 'Remove an environment variable or secret',
  description: 'Removes an environment variable / secret from the app and restarts it. app_status lists the names that are set (never the values).',
  inputSchema: { name: appName, key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), restart: z.boolean().default(true) },
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async ({ name, key, restart }) => run(async () => ok(json(await api('DELETE', `/v1/apps/${name}/env/${key}?restart=${restart}`)))));

server.registerTool('restore_version', {
  title: 'Go back to an earlier version',
  description: 'Puts an earlier version of the app online again: it becomes the newest version (nothing is lost, the history is kept) and is published. ' +
    'app_status lists the versions (commit, date, message). Use it when the latest version broke something. Confirm with the user first.',
  inputSchema: { name: appName, commit: z.string().regex(/^[0-9a-f]{7,40}$/).describe('commit of the version, from app_status') },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ name, commit }) => run(async () => ok(json(await api('POST', `/v1/apps/${name}/restore`, { commit }, 15 * 60_000)))));

server.registerTool('set_visibility', {
  title: 'Choose who can open the app',
  description: 'Who can open the app when Apprua is on the local network or the internet: "private" (only the owner and the administrators), ' +
    '"team" (anyone with an Apprua account, the default) or "public" (anyone, no sign-in: only for apps meant for everybody). ' +
    'Applies at once. Ask the user before making an app public.',
  inputSchema: { name: appName, visibility: z.enum(['private', 'team', 'public']) },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ name, visibility }) => run(async () => ok(json(await api('PUT', `/v1/apps/${name}/visibility`, { visibility })))));

server.registerTool('archive_app', {
  title: 'Archive app',
  description: 'Stops and archives an app of the user: code and data are kept and an administrator can restore it. Confirm with the user first.',
  inputSchema: { name: appName }, annotations: { destructiveHint: true, openWorldHint: true },
}, async ({ name }) => run(async () => ok(json(await api('DELETE', `/v1/apps/${name}`)))));

server.registerTool('clone_app', {
  title: 'Download the code of an app',
  description: 'Downloads the latest code of one of the user\'s apps into a new local folder, to change it and publish it again with update_app.',
  inputSchema: { name: appName, path: z.string().describe('Absolute path of the destination folder (must not exist)') },
  annotations: { destructiveHint: false, openWorldHint: true },
}, async ({ name, path }) => run(async () => {
  const dest = resolve(path);
  if (existsSync(dest)) return fail(`${dest} already exists: choose a new folder.`);
  const { data, headers } = await download(`/v1/apps/${name}/source`);
  const tmp = join(mkdtempSync(join(tmpdir(), 'apprua-clone-')), 'app.tar.gz');
  writeFileSync(tmp, data);
  try {
    mkdirSync(dest, { recursive: true });
    await tar.x({ file: tmp, cwd: dest, strict: true });
  } finally { rmSync(dirname(tmp), { recursive: true, force: true }); }
  const s = await api('GET', `/v1/apps/${name}`);
  saveState(dest, { app: name, url: s.url, commit: headers.get('x-apprua-commit') ?? s.last_commit ?? '' });
  return ok(`Downloaded ${name} into ${dest}. Change the files there, then call update_app with this path.`);
}));

// Tools for administrators: registered only when the token belongs to one (checked once at start).
const me = await api<{ role: string }>('GET', '/v1/me', undefined, 5000).catch(() => ({ role: 'unknown' }));
if (me.role === 'admin') {
  const email = z.string().email().describe('Email of the person');
  const adminTool = (name: string, title: string, description: string, inputSchema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, boolean>, handler: (a: any) => Promise<Content>) =>
    server.registerTool(name, { title, description: `[ADMIN] ${description}`, inputSchema, annotations: { openWorldHint: true, ...annotations } },
      (a: any) => run(() => handler(a)));

  adminTool('catalog', 'All active apps (admin)', `All active apps published on ${BRAND} with owner, description and URL.`,
    {}, { readOnlyHint: true }, async () => ok(json(await api('GET', '/v1/catalog'))));

  adminTool('admin_list_apps', 'All apps (admin)',
    `Lists ALL apps on ${BRAND} of every person, also stopped and archived, with owner, status, review date and last deploy result. ` +
    'The regular tools (app_status, app_logs, restart/stop/start_app, set_env, update_app, archive_app) also work on other people\'s apps for an admin.',
    {}, { readOnlyHint: true }, async () => ok(json(await api('GET', '/v1/admin/apps'))));

  adminTool('admin_change_owner', 'Change app owner (admin)',
    'Transfers an app to another person (who must already have an account). Confirm with the user first.',
    { name: appName, owner: email }, { destructiveHint: false, idempotentHint: true },
    async ({ name, owner }) => ok(json(await api('PUT', `/v1/admin/apps/${name}/owner`, { owner }))));

  adminTool('admin_restore_app', 'Reactivate an app (admin)', 'Restarts a stopped or archived app.',
    { name: appName }, { destructiveHint: false, idempotentHint: true },
    async ({ name }) => ok(json(await api('POST', `/v1/admin/apps/${name}/restore`))));

  adminTool('admin_delete_app', 'Delete an app permanently (admin)',
    'IRREVERSIBLE: deletes the container and its data volume (a copy of the code is kept on the server). ' +
    'Prefer archive_app when unsure. Before calling, show the user the app name, owner and that data will be lost, and get an explicit yes; ' +
    '"confirm" must repeat the app name exactly.',
    { name: appName, confirm: z.string().describe('The app name again, as typed confirmation') }, { destructiveHint: true },
    async ({ name, confirm }) => ok(json(await api('DELETE', `/v1/admin/apps/${name}?confirm=${encodeURIComponent(confirm)}`))));

  adminTool('admin_set_limits', 'Change app resources (admin)',
    'Changes CPU / memory limits of an app (the most memory one app can get depends on the machine; app_status says when an app ran out of memory). Applied at the next restart or deploy: then call restart_app. Administrators can also change the memory on the page of the app in the portal.',
    { name: appName, cpus: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('e.g. "1"'), memory: z.string().regex(/^\d+[mgMG]$/).optional().describe('e.g. "1g" or "768m"') },
    { destructiveHint: false, idempotentHint: true },
    async ({ name, cpus, memory }) => ok(json(await api('PUT', `/v1/admin/apps/${name}/limits`, { cpus, memory }))));

  adminTool('admin_set_review', 'Change review date (admin)', 'Sets the next review date of an app (YYYY-MM-DD).',
    { name: appName, review_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }, { destructiveHint: false, idempotentHint: true },
    async ({ name, review_at }) => ok(json(await api('PUT', `/v1/admin/apps/${name}/review`, { review_at }))));

  adminTool('admin_list_users', 'People (admin)', 'People with an account, with role, token expiry, quota and number of active apps.',
    {}, { readOnlyHint: true }, async () => ok(json(await api('GET', '/v1/admin/users'))));

  adminTool('admin_set_quota', 'Change app quota (admin)', 'Sets how many active apps a person may have.',
    { email, quota: z.number().int().min(0).max(500) }, { destructiveHint: false, idempotentHint: true },
    async ({ email: e, quota }) => ok(json(await api('PUT', `/v1/admin/users/${encodeURIComponent(e)}/quota`, { quota }))));

  adminTool('admin_revoke_token', 'Revoke a personal token (admin)',
    'Immediately revokes a person\'s personal token (e.g. lost laptop). Their apps stay online. Confirm with the user first.',
    { email }, { destructiveHint: true, idempotentHint: true },
    async ({ email: e }) => ok(json(await api('POST', `/v1/admin/users/${encodeURIComponent(e)}/revoke`))));

  adminTool('admin_report', 'Report (admin)',
    'Report: apps due for review in 30 days, apps stopped for more than 60 days, full inventory, failed deploys in the last 30 days.',
    {}, { readOnlyHint: true }, async () => ok(json(await api('GET', '/v1/admin/report'))));
}

await server.connect(new StdioServerTransport());
