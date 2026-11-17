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

const payload = join(homedir(), '.config', 'magpie', 'chatgpt-web-native', 'runtime-6.1.18', 'payload');
const entry = resolve(process.env.NATIVE_REFERENCE_CLI ?? join(payload, 'app', 'cli.js'));
const bun = resolve(process.env.NATIVE_REFERENCE_BUN ?? join(payload, 'runtime', process.platform === 'win32' ? 'bun.exe' : 'bun'));
const fixture = fileURLToPath(new URL('./fixtures/native-tool-emission-proof.mjs', import.meta.url));
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const explicit = process.env.NATIVE_REFERENCE_CLI !== undefined || process.env.NATIVE_REFERENCE_BUN !== undefined;

// Runs automatically when the original runtime is installed. Explicit fixture
// overrides must be valid; missing or changed requested pins are never skipped.
test('pinned broker tool delivery precedes client execution and early quota revokes pending tools', {
  skip: !explicit && (!existsSync(entry) || !existsSync(bun)) && 'original pinned Native CLI/Bun is not installed',
  timeout: 30_000,
}, async t => {
  assert.equal(hash(await readFile(entry)), pin, 'only the original pinned CLI may execute');
  const temporary = await mkdtemp(join(tmpdir(), 'native-tool-emission-wrapper-'));
  t.after(async () => {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'CODEX_HOME', 'CODEX_CHATGPT_WEB_HOME', 'MAGPIE_NATIVE_CHECKPOINT_HOME', 'TEMP', 'TMP', 'TMPDIR']) env[name] = temporary;
  env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = '[]';
  try {
    // The fixture blocks fetch, disables CLI startup and socket startup, and
    // substitutes only browser generation and an inert client counter.
    const { stdout } = await promisify(execFile)(bun, [fixture, entry], {
      cwd: temporary, env, windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20,
    });
    assert.ok(stdout.includes('PINNED_TOOL_EMISSION_PROOF_OK ' + pin));
    const evidence = stdout.split(/\r?\n/).filter(line => line.startsWith('pinned-tool-proof: '));
    assert.equal(evidence.length, 2);
    for (const line of evidence) t.diagnostic(line);
  } finally {
    assert.equal(hash(await readFile(entry)), pin, 'installed CLI remains unchanged');
  }
});
