import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { nativeWindowPolicy, PINNED_WINDOW_CLI_SHA256 } from '../src/native/window-policy.mjs';

const root = join(homedir(), '.config', 'magpie', 'chatgpt-web-native', 'runtime-6.1.18', 'payload');
export const defaultProbePaths = () => ({ cli: join(root, 'app', 'cli.js'), bun: join(root, 'runtime', 'bun.exe') });
const fixture = fileURLToPath(new URL('../test/fixtures/native-window-probe-fixture.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function runChild(bun, args, scratch, timeoutMs) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE)$/i.test(name)));
  const child = spawn(bun, [fixture, ...args], {
    cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      CODEX_CHATGPT_WEB_HOME: scratch, CODEX_HOME: join(scratch, 'codex'),
      CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS: '0', MAGPIE_NATIVE_BROWSER_CDP: '', MAGPIE_NATIVE_CHECKPOINT_HOME: '' },
  });
  let stdout = '', stderr = '', expired = false;
  const limit = 4 * 1024 * 1024;
  const capture = field => chunk => {
    if (field === 'out') stdout += chunk; else stderr += chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) child.kill();
  };
  child.stdout.on('data', capture('out')); child.stderr.on('data', capture('err'));
  const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
  try {
    const result = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
    if (expired || result.code !== 0) throw new Error(`Offline ${args[1]} fixture failed (${result.code}/${result.signal}, timeout=${expired}): ${stderr.slice(-12000)}\n${stdout.slice(-2000)}`);
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length !== 1) throw new Error('Unexpected fixture output');
    return JSON.parse(lines[0]);
  } finally { clearTimeout(timer); }
}

/** Imports the pinned compiler only inside a startup-disabled, network-disabled
 * child. No runtime/account discovery, provider import or production preload.
 * --out preserves synthetic source and actual physical payloads for inspection.
 */
export async function runNativeWindowProbe({ cli = defaultProbePaths().cli, bun = defaultProbePaths().bun,
  out, timeoutMs = 240_000, accountCatalogMaxTokens = 410_000, outputReserveTokens = 16_384 } = {}) {
  cli = resolve(cli); bun = resolve(bun);
  const before = await readFile(cli);
  if (hash(before) !== PINNED_WINDOW_CLI_SHA256) throw new Error('Pinned CLI checksum mismatch; no child launched');
  const policy = nativeWindowPolicy({ accountCatalogMaxTokens, outputReserveTokens });
  if (policy.inputTokenCeilingExclusive <= 380_000) throw new Error('The requested policy cannot admit the 380K test; lower tiers alone are not this probe');
  if (out) { out = resolve(out); await mkdir(out, { recursive: false }); }
  const scratch = await mkdtemp(join(tmpdir(), 'native-window-probe-'));
  const childPath = relative(resolve(tmpdir()), resolve(scratch));
  if (!childPath || isAbsolute(childPath) || childPath.startsWith('..')) throw new Error('Invalid probe scratch path');
  try {
    const runs = [];
    for (const mode of ['reference', 'candidate']) {
      const artifactDir = out ? join(out, mode) : '';
      if (artifactDir) await mkdir(artifactDir);
      runs.push(await runChild(bun, [cli, mode, JSON.stringify({ accountCatalogMaxTokens, outputReserveTokens }), artifactDir], scratch, timeoutMs));
    }
    for (const source of runs[0].cases) {
      const candidate = runs[1].cases.find(row => row.family === source.family && row.targetInputTokens === source.targetInputTokens);
      if (!candidate || source.canonicalSha256 !== candidate.canonicalSha256
          || source.multipartRecordsSha256 !== candidate.multipartRecordsSha256
          || source.inputTokens !== candidate.inputTokens) throw new Error('Reference/candidate corpus or compiler payload drift');
    }
    const report = {
      schemaVersion: 1, status: 'offline-pinned-compiler-pass', generatedAt: new Date().toISOString(),
      pinnedCliSha256: PINNED_WINDOW_CLI_SHA256, policy, runs,
      onlineRequests: 0, accountFilesRead: false, productionRuntimeImported: false,
      canClaimWebCapacity: false,
      limitations: [
        'Only actual pinned parser/compiler/tokenizer and local preflight were exercised. No browser, account, server receipt, recall or live compaction was tested.',
        '400K is a total-window policy ceiling. The catalogue max_tokens field has unknown semantics and is not an input entitlement.',
        'The 16384 default output reserve is an explicit experimental allocation, not a verified upstream reasoning/output requirement.',
        'Reference o200k_base counting (4096-character chunks) and whole-string o200k_base counting are local estimates of model input.',
        'The ordinary reference baseline is 112193; installed production canonical guards remain separate and unchanged.',
      ],
    };
    if (out) await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
  } finally {
    // scratch is a verified direct child of the OS temp directory created here.
    await rm(scratch, { recursive: true, force: true });
    if (hash(await readFile(cli)) !== hash(before)) throw new Error('Pinned CLI changed during probe');
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    cli: { type: 'string' }, bun: { type: 'string' }, out: { type: 'string' },
    help: { type: 'boolean' }, 'account-max': { type: 'string' }, 'output-reserve': { type: 'string' },
  }, strict: true });
  if (values.help) {
    console.log('Offline pinned compiler probe: node scripts/native-window-probe.mjs [--cli FILE] [--bun FILE] [--out NEW_DIRECTORY] [--account-max 410000] [--output-reserve 16384]\nRuns 100K baseline, 128K, 256K, 380K for both Pro families, original and experimental six-part compilation. No online requests. --out retains synthetic canonical input, physical messages, manifests and report.');
    return;
  }
  const report = await runNativeWindowProbe({ cli: values.cli, bun: values.bun, out: values.out,
    ...(values['account-max'] ? { accountCatalogMaxTokens: Number(values['account-max']) } : {}),
    ...(values['output-reserve'] ? { outputReserveTokens: Number(values['output-reserve']) } : {}) });
  console.log(JSON.stringify(values.out ? { status: report.status, report: join(resolve(values.out), 'report.json'), canClaimWebCapacity: false }
    : report, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
