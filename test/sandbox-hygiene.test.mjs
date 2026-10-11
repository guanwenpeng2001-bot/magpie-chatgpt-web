import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import vm from 'node:vm';
import * as live from '../integrations/verify-live.mjs';

async function cleanupFixture(sandbox, archive) {
  const source = await fs.readFile(new URL('../integrations/sandbox.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('} finally {', source.indexOf("Sandbox failed:")) + 11);
  return vm.runInNewContext('(async () => {' + block + ')()', {
    ...fs, ...live, join, resolve, relative, isAbsolute, sep, sandbox,
    source: resolve('.'), host: null, directBridge: null,
    process: { argv: ['--live-once'], env: { CHATGPT_WEB_LIVE_ARCHIVE: archive } },
    console: { log() {} },
  });
}

test('archive failure removes the sandbox instead of retaining credential storage', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'archive-failure-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sandbox = join(root, 'sandbox');
  await fs.mkdir(join(sandbox, 'home'), { recursive: true });
  await fs.writeFile(join(sandbox, 'home', 'plugin-auth.json'), '{}');
  const archive = join(root, 'blocked');
  await fs.writeFile(archive, 'not a directory');
  await assert.rejects(cleanupFixture(sandbox, archive), /Live archive failed/);
  await assert.rejects(fs.stat(sandbox), { code: 'ENOENT' });
});

test('an in-worktree archive destination is refused and the sandbox is removed', async t => {
  const sandbox = await fs.mkdtemp(join(tmpdir(), 'archive-target-test-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  await assert.rejects(cleanupFixture(sandbox, resolve('..archive-fixture')), /Live archive failed/);
  await assert.rejects(fs.stat(sandbox), { code: 'ENOENT' });
});

test('live sandboxes are allocated outside the source tree', async () => {
  const source = await fs.readFile(new URL('../integrations/sandbox.mjs', import.meta.url), 'utf8');
  assert.match(source, /mkdtemp\(join\(tmpdir\(\), 'chatgpt-web-sandbox-'\)\)/);
});

test('archive output omits cookie-source paths and credential-channel header names', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'archive-redaction-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sandbox = join(root, 'sandbox');
  const archive = join(root, 'archive');
  await fs.mkdir(sandbox);
  await fs.writeFile(join(sandbox, 'live-backend.mjs'), 'const source = await readFile("C:/fixture/private-source.txt",\'utf8\');');
  await fs.writeFile(join(sandbox, 'live-facts.json'), '{}');
  await fs.writeFile(join(sandbox, 'live-ledger.json'), JSON.stringify({ posts: [{ headerNames: ['content-type', 'x-conduit-token', 'set-cookie', 'authorization'] }] }));
  await cleanupFixture(sandbox, archive);
  assert.doesNotMatch(await fs.readFile(join(archive, 'live-backend.mjs'), 'utf8'), /private-source/);
  assert.deepEqual(JSON.parse(await fs.readFile(join(archive, 'live-ledger.json'), 'utf8')).posts[0].headerNames, ['content-type']);
});
