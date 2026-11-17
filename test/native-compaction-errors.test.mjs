import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { patchNativeCompactionErrors } from '../src/native/compaction-errors.mjs';

const payload = join(homedir(), '.config', 'magpie', 'chatgpt-web-native', 'runtime-6.1.18', 'payload');
const entry = resolve(process.env.NATIVE_REFERENCE_CLI ?? join(payload, 'app', 'cli.js'));
const bun = resolve(process.env.NATIVE_REFERENCE_BUN ?? join(payload, 'runtime', process.platform === 'win32' ? 'bun.exe' : 'bun'));
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const explicit = process.env.NATIVE_REFERENCE_CLI !== undefined || process.env.NATIVE_REFERENCE_BUN !== undefined;
const pinned = { skip: !explicit && (!existsSync(entry) || !existsSync(bun)) && 'original pinned Native CLI/Bun is not installed', timeout: 30_000 };
const catchAnchor = '}catch(y){let P={type:"error",message:y instanceof Error?y.message:String(y)};r.onAdapterEvent?.(P),T.push(P)}finally{T.close()}},M=hE(d)';
const resultAnchor = 'return g(R),Response.json(R)}async function cd(';

test('compaction error transform is self-contained and rejects missing, duplicate, changed or already patched anchors', () => {
  const source = catchAnchor + resultAnchor;
  const isolated = runInNewContext('(' + patchNativeCompactionErrors.toString() + ')');
  const transformed = patchNativeCompactionErrors(source);
  assert.equal(isolated(source), transformed);
  assert.match(transformed, /y instanceof q\?magpieNativeCompactionErrorFields/);
  for (const value of [undefined, null, Buffer.from(source)]) assert.throws(() => patchNativeCompactionErrors(value), TypeError);
  for (const anchor of [catchAnchor, resultAnchor]) {
    assert.throws(() => patchNativeCompactionErrors(source.replace(anchor, 'changed')), /anchor mismatch/);
    assert.throws(() => patchNativeCompactionErrors(source + anchor), /anchor mismatch/);
  }
  assert.throws(() => patchNativeCompactionErrors(transformed), /already patched/);
});

for (const mode of ['baseline', 'patched']) test(`actual pinned Ls/cd compaction refusal and summary contract (${mode})`, pinned, async t => {
  assert.equal(hash(await readFile(entry)), pin);
  const temporary = await mkdtemp(join(tmpdir(), 'native-compaction-errors-'));
  t.after(async () => {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT']) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'CODEX_HOME', 'CODEX_CHATGPT_WEB_HOME', 'MAGPIE_NATIVE_CHECKPOINT_HOME', 'TEMP', 'TMP', 'TMPDIR']) env[name] = temporary;
  env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = '[]';
  try {
    const { stdout } = await promisify(execFile)(bun,
      [fileURLToPath(new URL('./fixtures/native-compaction-errors-fixture.mjs', import.meta.url)), entry, mode],
      { cwd: temporary, env, windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20 });
    assert.ok(stdout.includes('PINNED_COMPACTION_ERRORS_OK ' + mode));
    const evidence = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('compaction-errors-evidence: ')).slice('compaction-errors-evidence: '.length));
    assert.equal(evidence.checks, 55);
    t.diagnostic(JSON.stringify({ mode, checks: evidence.checks, history: evidence.results.find(item => item.name === 'history-proof'),
      quota: evidence.results.find(item => item.name === 'quota'), context: evidence.results.find(item => item.name === 'context') }));
  } finally { assert.equal(hash(await readFile(entry)), pin); }
});
