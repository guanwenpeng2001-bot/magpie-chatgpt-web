import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeDaemon, writePrivate } from '../src/native/daemon.mjs';
import { CompactionService, compactionProxy } from '../src/native/compaction.mjs';
import { ensureRuntime, compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';

const smoke = { skip: process.env.NATIVE_COMPACTION_SMOKE !== '1', timeout: 60_000 };
let installation;
const installed = () => installation ??= ensureRuntime({ fetch: () => { throw new Error('Offline runtime test cannot download'); } });

test('pinned automatic compaction retires real pending tools by source ownership', smoke, async t => {
  // Read the already installed pin directly: ensureRuntime can write an install lock/preload.
  const payload = join(nativeRoot(), 'runtime-6.1.18', 'payload');
  const entry = join(payload, 'app', 'cli.js');
  const original = await readFile(entry);
  assert.equal(createHash('sha256').update(original).digest('hex'),
    'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const scratch = fileURLToPath(new URL('../../native-live/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, 'compaction-retirement-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const preload = join(home, 'exports-preload.mjs');
  const exports = '\nexport { dn as TurnBroker, Cs as Worker, De as sessions, Bi as createAdapter, Le as callBroker, kg as namespace, _s as executionKey, Df as roundKey, $u as sourceKey, $f as instructionLineage, Lu as ownerKey, Di as conversationKey, cd as compactRequest, Ls as responseRequest, Fn as parseRequest, sd as route, vs as close };';
  const base = compactionPreloadSource(entry);
  const source = base.replace("return { contents, loader: 'js' };",
    `return { contents: contents + ${JSON.stringify(exports)}, loader: 'js' };`);
  assert.notEqual(source, base);
  await writeFile(preload, source);
  const fixture = fileURLToPath(new URL('../integrations/native-compaction-bundle-fixture.mjs', import.meta.url));
  const result = await promisify(execFile)(join(payload, 'runtime', 'bun.exe'),
    ['--preload', preload, fixture, entry, 'compaction-retirement'], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, 'codex'),
        CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: '[]', MAGPIE_NATIVE_CHECKPOINT_HOME: home },
      windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20,
    });
  assert.match(result.stdout, /compaction-retirement: passed/);
  for (const line of result.stdout.split(/\r?\n/).filter(line => line.startsWith('retirement-evidence: '))) {
    t.diagnostic(line);
  }
  assert.deepEqual(await readFile(entry), original, 'downloaded runtime remains unchanged');
});

// Empty scratch storage and a missing Chrome stop at the real browser boundary.
// The full server and preload are real; no tunnel process or signed-in account is used.
test('installed 6.1.18 full daemon reaches read-only compaction without a launcher', smoke, async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-compaction-runtime-'));
  const { runtimeCommand } = await installed();
  const owner = new NativeDaemon({ home, runtimeCommand });
  owner.config = { version: 3, releaseVersion: '6.1.18', mode: 'full', subagentProtocol: 'native',
    host: '127.0.0.1', port: await owner.allocatePort(), contextWindow: 256000, appName: 'Codex Compaction Fixture',
    browserHost: 'managed-chrome', browserInteractionMode: 'automatic',
    chromeExecutablePath: join(home, 'intentionally-missing-chrome.exe'), storageStatePath: join(home, 'storage.json'),
    brokerSocketPath: '\\\\.\\pipe\\compaction-fixture-' + randomUUID(), solAvailable: true,
    headed: false, autoApproveToolCalls: false, controlToken: randomBytes(32).toString('base64url'), runtimeCommand,
    tunnel: { binaryPath: join(home, 'unused-tunnel.exe'), tunnelId: 'tunnel_' + '0'.repeat(32),
      runtimeKeyFile: join(home, 'unused.key'), profileDir: join(home, 'tunnel'), profileName: 'fixture', alias: 'fixture' } };
  await writePrivate(owner.config.storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
  await writePrivate(`${owner.config.storageStatePath}.verified.json`, JSON.stringify({ version: 1, authenticated: true,
    verifiedAt: new Date().toISOString(), solAvailable: true }));
  await writePrivate(join(home, 'config.json'), JSON.stringify(owner.config));
  let logs = '';
  const child = spawn(runtimeCommand[0], [...runtimeCommand.slice(1), 'serve'], {
    cwd: home, env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, 'codex') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  child.stdout.on('data', bytes => { logs += bytes; });
  child.stderr.on('data', bytes => { logs += bytes; });
  const service = new CompactionService(owner);
  t.after(async () => {
    await service.stop();
    try {
      for (const action of ['drain', 'cancel-turns', 'shutdown']) await fetch(`http://127.0.0.1:${owner.config.port}/admin/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${owner.config.controlToken}` }, signal: AbortSignal.timeout(2000),
      });
    } finally {
      const timer = setTimeout(() => child.kill(), 3000);
      await done; clearTimeout(timer);
      await rm(home, { recursive: true, force: true });
    }
  });
  await owner.waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Full fixture exited: ' + logs);
    try { const health = await (await fetch(`http://127.0.0.1:${owner.config.port}/healthz`)).json(); return health.mode === 'full'; }
    catch { return false; }
  }, AbortSignal.timeout(15_000)).catch(error => { throw new Error(`${error.message}: ${logs}`); });
  await service.listen();
  const compact = compactionProxy(service.descriptor());
  for (const kind of ['v1', 'memento', 'v2']) {
    const metadata = { thread_id: `offline-thread-${kind}`, turn_id: `offline-turn-${kind}`,
      ...(kind === 'memento' ? { request_kind: 'compaction', compaction: { implementation: 'responses', strategy: 'memento' } } : {}) };
    const body = { model: 'chatgpt-web/gpt-6-sol', stream: false,
      input: [{ type: 'message', id: 'offline-user', role: 'user', content: [{ type: 'input_text', text: 'Inspect the fixture project.' }],
        internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id, content_item_kinds: ['user_message'] } },
      ...(kind === 'v2' ? [{ type: 'compaction_trigger' }] : [])] };
    const response = await compact(body, { 'x-codex-turn-metadata': JSON.stringify(metadata) },
      AbortSignal.timeout(20_000), kind === 'v1' ? '/v1/responses/compact' : '/v1/responses');
    const text = await response.text();
    assert.match(text, /Configured Chrome executable does not exist/);
    assert.doesNotMatch(text + logs, /compaction_control_unavailable/);
  }
});

test('pinned bundle completes and authenticates continuation in the full owner', smoke, async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-compaction-continuation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { runtimeCommand } = await installed();
  const entry = runtimeCommand.at(-1);
  const original = await readFile(entry);
  const preload = join(home, 'exports-preload.mjs');
  // Only expose existing bundle bindings to the fixture. Production has no test API.
  const exports = '\nexport { dn as TurnBroker, ci as opaqueId, ff as chromium, Cs as Worker, cd as compactRequest, Ls as responseRequest, Fn as parseRequest, sd as route, Nh as restore, H_ as sourceRevision, _i as revisions, ue as identity, Xt as compilePrompt, zt as summaryPrefix, vs as close, da as readAnnouncements, mu as assertModelFamily, pu as selectModelFamily, r_ as familyMatches, rawModelAnnouncements };';
  const source = compactionPreloadSource(entry).replace("return { contents, loader: 'js' };",
    `return { contents: contents + '\\n' + source.slice(source.indexOf('async function da(e)'), source.indexOf('function fc(e)'))
      .replace('async function da(e)', 'async function rawModelAnnouncements(e)') + ${JSON.stringify(exports)}, loader: 'js' };`);
  assert.notEqual(source, compactionPreloadSource(entry));
  await writeFile(preload, source);
  const fixture = fileURLToPath(new URL('../integrations/native-compaction-bundle-fixture.mjs', import.meta.url));
  for (const phase of ['same-process', 'fresh-process', 'durable-fresh', 'persistence-failure', 'durable-recompact', 'durable-fresh', 'turn-tokens', 'cdp-ownership', 'model-announcements']) {
    const result = await promisify(execFile)(runtimeCommand[0], ['--preload', preload, fixture, entry, phase], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, 'codex'),
        MAGPIE_NATIVE_CHECKPOINT_HOME: ['same-process', 'durable-fresh', 'durable-recompact', 'persistence-failure'].includes(phase) ? home : '' },
      windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20,
    });
    assert.match(result.stdout, new RegExp(`${phase}: passed`));
    t.diagnostic(`${phase}: pinned runtime assertions passed`);
  }
  assert.deepEqual(await readFile(entry), original, 'downloaded runtime remains unchanged');
});
