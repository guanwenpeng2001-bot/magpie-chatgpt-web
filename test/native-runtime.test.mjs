import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ensureRuntime, RELEASES } from '../src/native/runtime.mjs';

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
