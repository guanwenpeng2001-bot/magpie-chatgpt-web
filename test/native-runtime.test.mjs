import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ensureRuntime, RELEASES, compactionPreloadSource, launchNativeBrowser } from '../src/native/runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloads = 0, extractions = 0;
  const payloads = [{ 'runtime/bun.exe': 'bun', 'app/cli.js': 'cli' },
    { 'tunnel-client.exe': 'tunnel', 'cloudflared.exe': 'cloud', 'cloudflared-manifest.json': '{}' }];
  const releases = payloads.map((files, i) => ({ name: `fixture-${i}`, url: `https://download.invalid/${i}`,
    sha256: hash(JSON.stringify(files)), files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, hash(value)])) }));
  const fetch = async url => { downloads++; return new Response(JSON.stringify(payloads[Number(url.split('/').at(-1))])); };
  const extract = async (archive, destination) => {
    extractions++;
    for (const [name, bytes] of Object.entries(JSON.parse(await readFile(archive, 'utf8')))) {
      await mkdir(dirname(join(destination, name)), { recursive: true });
      await writeFile(join(destination, name), bytes);
    }
  };
  return { root, releases, fetch, extract, counts: () => [downloads, extractions] };
}

test('native installer pins runtime and all tunnel dependencies', () => {
  assert.equal(RELEASES[0].sha256, '813690d379fd2fc91b0c95a54ab94026e9f53c53a5d43c39eeca98947cbf3fea');
  assert.match(RELEASES[1].url, /v0\.0\.16/);
  assert.deepEqual(Object.keys(RELEASES[1].files), ['tunnel-client.exe', 'cloudflared.exe', 'cloudflared-manifest.json']);
});

test('install is durable, concurrent calls coalesce and verified reuse is offline', async t => {
  const fixtureOptions = await fixture(t);
  const [one, two] = await Promise.all([ensureRuntime(fixtureOptions), ensureRuntime(fixtureOptions)]);
  assert.deepEqual(one, two);
  assert.ok(one.runtimeCommand.every(path => path.startsWith(fixtureOptions.root)));
  assert.deepEqual(await ensureRuntime(fixtureOptions), one);
  assert.deepEqual(fixtureOptions.counts(), [2, 2]);
});

test('bad download is rejected before extraction', async t => {
  const options = await fixture(t);
  await assert.rejects(ensureRuntime({ ...options, fetch: async () => new Response('bad') }), /checksum/);
  assert.deepEqual(options.counts(), [0, 0]);
});

test('mismatching existing install is preserved without a download', async t => {
  const options = await fixture(t);
  const installed = await ensureRuntime(options);
  await writeFile(installed.runtimeCommand[1], 'modified');
  await assert.rejects(ensureRuntime(options), /refusing to overwrite/);
  assert.equal(await readFile(installed.runtimeCommand[1], 'utf8'), 'modified');
  assert.deepEqual(options.counts(), [2, 2]);
});

test('partial existing installation is never overwritten', async t => {
  const options = await fixture(t);
  await mkdir(join(options.root, options.releases[0].name));
  await assert.rejects(ensureRuntime(options), /refusing to overwrite/);
  assert.deepEqual(options.counts(), [0, 0]);
});

test('extracted dependency hashes are verified independently of archive hash', async t => {
  const options = await fixture(t);
  options.releases[1].files['cloudflared.exe'] = hash('wrong');
  await assert.rejects(ensureRuntime(options), /dependency checksum/);
});

test('compaction preload only reads the pinned entry and rejects changed runtime bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-preload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'app/cli.js');
  const previous = globalThis.Bun;
  t.after(() => { if (previous === undefined) delete globalThis.Bun; else globalThis.Bun = previous; });
  let onLoad, reads = 0;
  globalThis.Bun = { plugin({ setup }) { setup({ onLoad(_options, callback) { onLoad = callback; } }); },
    file(path) { assert.equal(path, entry); reads++; return { arrayBuffer: async () => new TextEncoder().encode('unverified runtime').buffer }; } };
  await import(`data:text/javascript;base64,${Buffer.from(compactionPreloadSource(entry)).toString('base64')}`);
  assert.equal(await onLoad({ path: join(root, 'unrelated/cli.js') }), undefined);
  assert.equal(reads, 0);
  await assert.rejects(onLoad({ path: entry }), /shared compaction runtime checksum mismatch/);
  assert.equal(reads, 1);
});

test('native browser launches unchanged when no CDP endpoint is supplied', async () => {
  const options = { executablePath: 'fixture/chrome.exe', headless: true };
  const browser = { newContext: async () => ({ owned: true }) };
  let launches = 0;
  const chromium = { async launch(received) { assert.equal(received, options); launches++; return browser; },
    connectOverCDP() { assert.fail('no CDP connection without an endpoint'); } };
  for (const endpoint of ['', undefined]) {
    // Pass a deliberately empty environment for the default-argument case.
    const old = process.env.MAGPIE_NATIVE_BROWSER_CDP;
    delete process.env.MAGPIE_NATIVE_BROWSER_CDP;
    try { assert.equal(await launchNativeBrowser(chromium, options, endpoint), browser); }
    finally { if (old !== undefined) process.env.MAGPIE_NATIVE_BROWSER_CDP = old; }
  }
  assert.equal(launches, 2);
  assert.deepEqual(await browser.newContext(), { owned: true });
});

test('native browser borrows the default context without creating or closing contexts', async () => {
  let disconnected = false;
  const context = { owner: 'backend', close() { assert.fail('borrowed context must remain owned by the backend'); } };
  const browser = { contexts() { return [context, { owner: 'other' }]; },
    newContext() { assert.fail('must not create an incognito context'); },
    async close() { assert.equal(this, browser); disconnected = true; } };
  const close = browser.close;
  const chromium = { launch() { assert.fail('must not launch another browser'); },
    async connectOverCDP(endpoint) { assert.equal(endpoint, 'http://127.0.0.1:9222'); return browser; } };
  const attached = await launchNativeBrowser(chromium, { headless: true }, 'http://127.0.0.1:9222');
  assert.equal(attached, browser);
  assert.equal(await attached.newContext({ storageState: 'must-not-import.json' }), context);
  assert.equal(await attached.newContext(), context);
  assert.equal(attached.close, close);
  await attached.close();
  assert.equal(disconnected, true);
  assert.equal(context.owner, 'backend');
});

test('native browser rejects noncanonical or nonloopback CDP endpoints before connecting', async () => {
  const chromium = { launch() { assert.fail('invalid endpoint cannot fall back to launch'); },
    connectOverCDP() { assert.fail('invalid endpoint cannot connect'); } };
  for (const endpoint of ['http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:09222',
    'http://localhost:9222', 'http://127.1:9222', 'http://[::1]:9222', 'http://192.168.1.1:9222',
    'https://127.0.0.1:9222', 'ws://127.0.0.1:9222', 'http://user@127.0.0.1:9222',
    'http://127.0.0.1:9222/', 'http://127.0.0.1:9222/json/version', 'http://127.0.0.1:9222?x=1',
    'http://127.0.0.1:9222#x', ' http://127.0.0.1:9222', 'http://127.0.0.1:9222\n', ' ', null]) {
    await assert.rejects(launchNativeBrowser(chromium, {}, endpoint), /Invalid MAGPIE_NATIVE_BROWSER_CDP/);
  }
});

test('native browser disconnects an unusable CDP attachment and propagates connection failures', async () => {
  let disconnects = 0;
  const chromium = { launch() { assert.fail('no fallback after CDP failure'); },
    async connectOverCDP() { return { contexts: () => [], async close() { disconnects++; } }; } };
  await assert.rejects(launchNativeBrowser(chromium, {}, 'http://127.0.0.1:65535'), /no default context/);
  assert.equal(disconnects, 1);
  chromium.connectOverCDP = async () => { throw new Error('fixture connection failed'); };
  await assert.rejects(launchNativeBrowser(chromium, {}, 'http://127.0.0.1:1'), /fixture connection failed/);
  assert.equal(disconnects, 1);
});
