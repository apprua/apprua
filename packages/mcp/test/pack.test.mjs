import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { spawn } from 'node:child_process';
import * as tar from 'tar';

test('server lists 14 tools with annotations over stdio', async () => {
  const p = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, APPRUA_URL: 'https://x', APPRUA_TOKEN: 't' } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  let buf = '';
  const tools = await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => {
      buf += d; for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        if (m.id === 2) resolve(m.result.tools);
      }
      buf = buf.split('\n').at(-1);
    });
    setTimeout(() => reject(new Error('timeout')), 10000);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  });
  p.kill();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(tools.length, 14);
  assert.equal(by.stop_app.annotations.destructiveHint, true);
  assert.equal(by.archive_app.annotations.destructiveHint, true);
  assert.equal(by.list_my_apps.annotations.readOnlyHint, true);
  assert.match(by.publish_app.description, /confirm/i);
});

test('packing respects .gitignore and always-excluded paths', async () => {
  const { listPublishable } = await import('./pack-under-test.mjs');
  const d = mkdtempSync(join(tmpdir(), 'pk-'));
  for (const f of ['index.html', 'src/app.js', 'node_modules/x/i.js', '.env', '.env.example', 'secret.txt', '.git/HEAD', '.apprua.json'])
    { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x'); }
  writeFileSync(join(d, '.gitignore'), 'secret.txt\n');
  const { files } = await listPublishable(d);
  assert.deepEqual(files, ['.env.example', '.gitignore', 'index.html', 'src/app.js']);
});

test('packing: .gitignore in subfolders, keys of the PC never, folders that are not a project refused', async () => {
  const { listPublishable, checkFolder } = await import('./pack-under-test.mjs');
  const d = mkdtempSync(join(tmpdir(), 'pk-'));
  for (const f of ['web/index.html', 'web/build/big.js', '.ssh/id_ed25519', '.aws/credentials', '.npmrc', '.bash_history'])
    { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x'); }
  writeFileSync(join(d, 'web/.gitignore'), 'build/\n');
  assert.deepEqual((await listPublishable(d)).files, ['web/.gitignore', 'web/index.html']);
  const home = join(tmpdir(), 'casa');
  assert.throws(() => checkFolder(home, home), /home folder/);
  assert.throws(() => checkFolder(tmpdir(), home), /contains your home/);
  assert.throws(() => checkFolder(join(home, '.ssh'), home), /keys and settings/);
  assert.throws(() => checkFolder(join(home, '.config', 'x'), home), /keys and settings/);
  assert.throws(() => checkFolder(join(home, 'a', '.aws'), home), /keys and settings/);
  assert.throws(() => checkFolder(parse(home).root, home), /root of a drive/);
  checkFolder(join(home, 'progetti', 'library'), home);   // a project may be called "library"
  checkFolder(join(home, 'progetti', 'notes'), home);
  // a link (a junction on Windows) that looks like a project but leads to the keys or to the home folder
  const realHome = mkdtempSync(join(tmpdir(), 'casa-'));
  mkdirSync(join(realHome, '.ssh'));
  const links = mkdtempSync(join(tmpdir(), 'link-'));
  symlinkSync(join(realHome, '.ssh'), join(links, 'my-app'), 'junction');
  symlinkSync(realHome, join(links, 'other-app'), 'junction');
  assert.throws(() => checkFolder(join(links, 'my-app'), realHome), /keys and settings/);
  assert.throws(() => checkFolder(join(links, 'other-app'), realHome), /home folder/);
});

test('admin tools appear only for an admin token', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ email: 'a@x', role: 'admin' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, APPRUA_URL: `http://127.0.0.1:${srv.address().port}`, APPRUA_TOKEN: 't' } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  let buf = '';
  const tools = await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => {
      buf += d; for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
        if (m.id === 2) resolve(m.result.tools);
      }
      buf = buf.split('\n').at(-1);
    });
    setTimeout(() => reject(new Error('timeout')), 10000);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  });
  p.kill(); srv.close();
  const names = tools.map((t) => t.name);
  assert.equal(tools.length, 25);
  assert.ok(names.includes('admin_delete_app') && names.includes('admin_list_apps'));
  assert.equal(tools.find((t) => t.name === 'admin_delete_app').annotations.destructiveHint, true);
});
