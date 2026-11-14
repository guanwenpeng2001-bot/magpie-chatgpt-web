import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { compactionPreloadSource } from '../src/native/runtime.mjs';

test('pinned managed host retains the actual source through one-shot compaction and physical retirement', {
  skip: process.env.NATIVE_RETAINED_HOST_SMOKE !== '1', timeout: 60000,
}, async t => {
  const entry = resolve(process.env.NATIVE_REFERENCE_CLI ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/app/cli.js', import.meta.url)));
  const bun = resolve(process.env.NATIVE_REFERENCE_BUN ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/runtime/bun.exe', import.meta.url)));
  const bytes = await readFile(entry);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const root = await mkdtemp(join(tmpdir(), 'native-retained-host-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); assert.deepEqual(await readFile(entry), bytes); });
  const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
  const exports = '\nexport { Cs as Worker, Bi as adapter, dn as Broker, Le as callBroker, De as sessions, kg as namespace, _s as executionKey, Di as conversationKey, ir as brokerEndpoint, Ku as retainedHandoff };';
  const base = compactionPreloadSource(entry);
  const source = base.replace("return { contents, loader: 'js' };", `
    const startup = ${JSON.stringify(startup)};
    if (contents.split(startup).length !== 2) throw new Error('Retained fixture startup mismatch');
    return { contents: contents.replace(startup, '') + ${JSON.stringify(exports)}, loader: 'js' };`);
  assert.notEqual(source, base);
  await writeFile(join(root, 'preload.mjs'), source);
  const fixture = fileURLToPath(new URL('./fixtures/native-retained-host-fixture.mjs', import.meta.url));
  const result = await promisify(execFile)(bun, ['--preload', join(root, 'preload.mjs'), fixture, entry, root], {
    windowsHide: true, timeout: 45000, maxBuffer: 1 << 20,
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', CODEX_CHATGPT_WEB_HOME: root,
      MAGPIE_NATIVE_CHECKPOINT_HOME: '', MAGPIE_NATIVE_BROWSER_CDP: '',
      MAGPIE_NATIVE_RETAINED_COMPACTION: process.env.NATIVE_RETAINED_HOST_BASELINE === '1' ? '0' : '1' },
  });
  assert.match(result.stdout, /Managed retained source integration passed/);
});
