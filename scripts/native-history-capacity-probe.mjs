import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { compactionPreloadSource } from '../src/native/runtime.mjs';

export const HISTORY_PROBE_PIN = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
export const HISTORY_PROBE_MIN_TOKENS = 1_000_000;
const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
const fixture = fileURLToPath(new URL('../test/fixtures/native-history-capacity-probe-fixture.mjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function defaultHistoryProbePaths() {
  const payload = join(homedir(), '.config/magpie/chatgpt-web-native/runtime-6.1.18/payload');
  return { cli: join(payload, 'app/cli.js'), bun: join(payload, 'runtime/bun.exe') };
}

// Keep the real pinned parser, resolver, tokenizer and patched broker. Only CLI
// startup is removed. The capture wrapper is extracted from the actual preload
// insertion, so this fixture cannot accidentally test a different capture path.
export function prepareHistoryProbePreload(cli, original) {
  if (sha256(original) !== HISTORY_PROBE_PIN) throw new Error('Pinned CLI checksum mismatch; no child launched');
  if (original.toString().split(startup).length !== 2) throw new Error('Pinned startup anchor drift');
  const source = compactionPreloadSource(cli), anchor = "return { contents, loader: 'js' };";
  if (source.split(anchor).length !== 2) throw new Error('History probe preload anchor drift');
  return source.replace(anchor, `
    const start = 'if(D||f._compactionRequest)await captureNativeHistory(';
    const end = 'if(f._compactionRequest){console.info("[chatgpt-web] compaction_phase entered");';
    if (contents.split(start).length !== 2 || contents.split(end).length !== 2
        || contents.split(${JSON.stringify(startup)}).length !== 2) throw Error('History probe capture/startup anchor drift');
    const a = contents.indexOf(start), b = contents.indexOf(end, a);
    if (b <= a) throw Error('History probe capture boundary drift');
    const capture = contents.slice(a, b);
    contents = contents.replace(${JSON.stringify(startup)}, '')
      + '\\nexport { Fn as parse, Jh as claim, Uh as compacted, Vu as Store, dn as Broker, dC as tokenizer, ue as identity, mt as wireName };'
      + '\\nexport async function archiveBoundary(f,D,m){' + capture + '}';
    return { contents, loader: 'js' };`);
}

async function child(bun, entry, scratch, phase, timeoutMs) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  const result = await promisify(execFile)(bun, ['--preload', join(scratch, 'preload.mjs'), fixture, entry, scratch, phase], {
    cwd: scratch, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
    env: { ...inherited, CODEX_HOME: join(scratch, 'codex'), CODEX_CHATGPT_WEB_HOME: scratch,
      CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: '[]', MAGPIE_NATIVE_CHECKPOINT_HOME: join(scratch, 'account'),
      MAGPIE_NATIVE_BROWSER_CDP: '', CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
  if (result.stderr.trim()) throw new Error(`Unexpected offline ${phase} stderr: ${result.stderr.slice(-3000)}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length !== 1) throw new Error(`Unexpected offline ${phase} stdout`);
  return JSON.parse(lines[0]);
}

/** Offline cumulative archive evidence only. No model request or native live
 * harness runs. Two sequential child processes share only their private disk
 * fixtures; the second process must recover without recapturing the corpus. */
export async function runNativeHistoryCapacityProbe({ cli = defaultHistoryProbePaths().cli,
  bun = defaultHistoryProbePaths().bun, timeoutMs = 240_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new TypeError('timeoutMs must be an integer in 1..600000');
  cli = resolve(cli); bun = resolve(bun);
  const original = await readFile(cli), preload = prepareHistoryProbePreload(cli, original);
  await access(bun);
  const scratch = await mkdtemp(join(tmpdir(), 'native-history-capacity-'));
  const relativeScratch = relative(resolve(tmpdir()), resolve(scratch));
  if (!relativeScratch || isAbsolute(relativeScratch) || relativeScratch.startsWith('..')) throw new Error('Invalid private probe directory');
  try {
    await writeFile(join(scratch, 'preload.mjs'), preload, { flag: 'wx', mode: 0o600 });
    const ingest = await child(bun, cli, scratch, 'ingest', timeoutMs);
    // execFile has observed the first process exit before the second is started.
    const reopen = await child(bun, cli, scratch, 'reopen', timeoutMs);
    if (ingest.pid === reopen.pid || ingest.processNonce === reopen.processNonce
        || JSON.stringify(ingest.corpus) !== JSON.stringify(reopen.corpus)
        || ingest.archiveSha256 !== reopen.archiveSha256 || reopen.corpusCaptures !== 0
        || !reopen.archiveUnchangedByContinuation || ingest.corpus.tokens < HISTORY_PROBE_MIN_TOKENS) {
      throw new Error('Offline history restart/integrity evidence mismatch');
    }
    return {
      schemaVersion: 1, status: 'offline-pinned-history-capacity-pass', live: false,
      canClaimWebCapacity: false, onlineRequests: 0, realSessionsTouched: false, realAccountFilesRead: false,
      pinnedCliSha256: HISTORY_PROBE_PIN,
      tokenizer: { method: 'dC().encode_ordinary(text).length', measurement: 'sum of whole original record encodings',
        excludes: ['environment metadata', 'compaction summary', 'tool wrappers', 'model input/output reserves'] },
      corpus: ingest.corpus, runs: [ingest, reopen],
      processRestart: { distinctProcesses: true, firstProcessExited: true, corpusRecaptured: false, archiveCiphertextUnchanged: true },
      limitations: [
        'Synthetic canonical rollout fixtures only; no real chat, account, browser, model request or live native harness proof.',
        'Uses the actual pinned dn Broker claim/invoke and MCP conversion with the repository history preload. Broker socket startup is disabled; transport is direct in-process dispatch.',
        'The million tokens are cumulative original text in a local archive. This does not prove a million-token Web context, server acceptance, model recall or live compaction.',
        'This checks orderly process exit and reopening, not crash recovery or multiple concurrent writer processes.',
      ],
    };
  } finally {
    // scratch was created here and checked as a child of the OS temp directory.
    await rm(scratch, { recursive: true, force: true });
    if (sha256(await readFile(cli)) !== sha256(original)) throw new Error('Pinned CLI changed during the offline probe');
  }
}

async function main() {
  const { values } = parseArgs({ options: { cli: { type: 'string' }, bun: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log('Offline cumulative history probe: node scripts/native-history-capacity-probe.mjs [--cli PINNED_CLI] [--bun BUN]\nMeasures >=1,000,000 original text tokens, searches and reads every record through the pinned broker, then repeats in a new process and verifies thread isolation. Synthetic temporary fixtures only; no downloads or online model requests. Not live Web capacity evidence.');
    return;
  }
  console.log(JSON.stringify(await runNativeHistoryCapacityProbe(values), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
