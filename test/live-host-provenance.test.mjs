import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Bridge } from '../src/bridge.mjs';
import { resolveLiveHost, hostBundlesFromCommandLines } from '../integrations/verify-live.mjs';

const pluginHostDir = root => join(root, '.cache', 'magpie', 'plugin-host');

async function writeValidBundle(root, body) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const filename = `host-${sha256.slice(0, 12)}.js`;
  await fs.mkdir(pluginHostDir(root), { recursive: true });
  await fs.writeFile(join(pluginHostDir(root), filename), body);
  return { filename, sha256 };
}

test('command-line extraction names only bundles under the live plugin-host directory', () => {
  assert.deepEqual(hostBundlesFromCommandLines([
    'C:\\Users\\Administrator\\.cache\\magpie\\bun\\1.4.3\\magpie-bun.exe run C:\\Users\\Administrator\\.cache\\magpie\\plugin-host\\host-52772ce524a8.js',
    'C:/Users/Administrator/.cache/magpie/bun/1.4.3/magpie-bun.exe run C:/Users/Administrator/.cache/magpie/plugin-host/host-6e85b6c721c8.js',
    'bun.exe run C:\\elsewhere\\plugin-host\\host-aaaaaaaaaaaa.js',
    'unrelated process command line',
  ]), ['host-52772ce524a8.js', 'host-6e85b6c721c8.js']);
});

test('the live instrument follows the machine: it selects the bundle the process table names, not a hardcoded one', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'live-host-selection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const superseded = await writeValidBundle(root, 'superseded host bundle body');
  const running = await writeValidBundle(root, 'host bundle the machine actually runs');
  const selected = await resolveLiveHost({
    liveHome: root,
    commandLines: [`C:\\Users\\Administrator\\.cache\\magpie\\bun\\1.4.3\\magpie-bun.exe run C:\\Users\\Administrator\\.cache\\magpie\\plugin-host\\${running.filename}`],
  });
  assert.equal(selected.filename, running.filename);
  assert.equal(selected.sha256, running.sha256);
  assert.notEqual(selected.filename, superseded.filename);
});

test('a bundle whose content does not match the digest in its filename is refused', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'live-host-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(pluginHostDir(root), { recursive: true });
  await fs.writeFile(join(pluginHostDir(root), 'host-aaaaaaaaaaaa.js'), 'tampered content');
  await assert.rejects(resolveLiveHost({
    liveHome: root,
    commandLines: ['magpie-bun.exe run C:\\Users\\x\\.cache\\magpie\\plugin-host\\host-aaaaaaaaaaaa.js'],
  }), /self-validation|does not begin with the digest/);
});

test('a running bundle that is absent from disk is refused specifically', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'live-host-absent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveLiveHost({
    liveHome: root,
    commandLines: ['magpie-bun.exe run C:\\Users\\x\\.cache\\magpie\\plugin-host\\host-000000000000.js'],
  }), /host-000000000000\.js.*does not exist|not installed/);
});

test('no running host process is refused instead of guessed', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'live-host-none-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveLiveHost({ liveHome: root, commandLines: ['unrelated process command line'] }),
    /cannot establish which host/);
});

test('several distinct running hosts are refused as ambiguous', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'live-host-ambiguous-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await writeValidBundle(root, 'first running bundle');
  const second = await writeValidBundle(root, 'second running bundle');
  await assert.rejects(resolveLiveHost({
    liveHome: root,
    commandLines: [
      `magpie-bun.exe run C:\\x\\.cache\\magpie\\plugin-host\\${first.filename}`,
      `magpie-bun.exe run C:\\x\\.cache\\magpie\\plugin-host\\${second.filename}`,
    ],
  }), /[Aa]mbiguous live host/);
});

test('real child completion diagnostics preserve the protocol channel', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'completion-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = join(root, 'backend.mjs');
  const main = new URL('../backend/main.mjs', import.meta.url).href;
  const adapter = new URL('../backend/site-adapter/index.mjs', import.meta.url).href;
  await fs.writeFile(child, `import { serve } from ${JSON.stringify(main)};
import { completionState } from ${JSON.stringify(adapter)};
await serve(process.stdin, process.stdout, { turnDriver: {
  async complete(command, guard, identity, signal, emit) {
    await completionState({ evaluate: async () => ({ complete: true, layout: 'legacy', signal: 'finished_successfully' }) });
    await emit({ type: 'delta', index: 0, text: 'verified' });
    await emit({ type: 'finish', reason: 'complete' });
    return { route: 'dom' };
  }, async close() {}
} });`);
  const bridge = new Bridge({ backend: child });
  try {
    const stream = await bridge.open({ method: 'complete', origin: 'http://127.0.0.1', model: 'auto', history: [{ role: 'user', content: 'fixture' }], auth: { profile: 'fixture', refresh: '__Secure-next-auth.session-token=fixture' } });
    const frames = [];
    for await (const frame of stream) frames.push(frame);
    assert.deepEqual(frames.map(frame => frame.type), ['delta', 'finish']);
    assert.equal(frames[0].text, 'verified');
  } finally { await bridge.dispose(); }
});

test('the live path carries no hardcoded host bundle name', async () => {
  const source = await fs.readFile(new URL('../integrations/verify-live.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /host-[0-9a-f]{12}\.js/);
});
