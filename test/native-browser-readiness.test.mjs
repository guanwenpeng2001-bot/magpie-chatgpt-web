import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { patchNativeBrowserReadiness } from '../src/native/browser-readiness.mjs';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';
import { compactionPreloadSource } from '../src/native/runtime.mjs';

const entry = resolve(process.env.NATIVE_REFERENCE_CLI
  ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/app/cli.js', import.meta.url)));
const bun = resolve(process.env.NATIVE_REFERENCE_BUN
  ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/runtime/bun.exe', import.meta.url)));
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const pinned = { skip: process.env.NATIVE_BROWSER_READINESS_SMOKE !== '1', timeout: 30_000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const bytes = await readFile(entry);
  assert.equal(digest(bytes), pin, 'explicit opt-in requires the original pinned fixture');
  return bytes;
}

// Execute the real production onLoad transform without running any CLI code.
async function transform(bytes) {
  let load;
  const script = compactionPreloadSource(entry)
    .replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '')
    .replace(`import { patchReferenceFixes } from ${JSON.stringify(new URL('../src/native/reference-fixes.mjs', import.meta.url).href)};`, '');
  runInNewContext(script, { createHash, resolve, Buffer, TextDecoder, patchReferenceFixes,
    Bun: { plugin({ setup }) { setup({ onLoad(_options, callback) { load = callback; } }); },
      file(path) { assert.equal(path, entry); return { arrayBuffer: async () => Uint8Array.from(bytes).buffer }; } },
  });
  assert.equal(await load({ path: resolve('unrelated/cli.js') }), undefined);
  return (await load({ path: entry })).contents;
}

test('browser readiness rejects non-source and missing anchors', () => {
  assert.throws(() => patchNativeBrowserReadiness(Buffer.from('source')), TypeError);
  assert.throws(() => patchNativeBrowserReadiness(''), /activeComposer anchor mismatch/);
});

test('readiness patch rejects full-method drift, duplicates and repeat application', pinned, async () => {
  const original = (await fixture()).toString('utf8');
  const start = original.indexOf('async activeComposer(');
  const end = original.indexOf('async prepareChatSurface(', start);
  const method = original.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal(original.split(method).length, 2);
  assert.throws(() => patchNativeBrowserReadiness(original.replace(method, method.replace('t=30000', 't=30001'))), /anchor mismatch/);
  assert.throws(() => patchNativeBrowserReadiness(original + method), /anchor mismatch/);
  const patched = patchNativeBrowserReadiness(original);
  assert.throws(() => patchNativeBrowserReadiness(patched), /anchor mismatch/);
  assert.equal(patched.slice(0, start), original.slice(0, start));
  assert.equal(patched.slice(patched.indexOf('async prepareChatSurface(', start)), original.slice(end),
    'all other methods, retry policy, auth and quota code remain byte-identical');
});

test('production preload composes readiness and rejects changed original bytes', pinned, async () => {
  const bytes = await fixture();
  const composed = await transform(bytes);
  assert.ok(composed.includes('function nativeBrowserVerification()'));
  assert.ok(composed.includes('function replacePlainTextInComposer('));
  assert.ok(composed.includes('launchNativeBrowser(ff,'));
  await assert.rejects(transform(Buffer.concat([bytes, Buffer.from('\n')])), /runtime checksum mismatch/);
  assert.deepEqual(await readFile(entry), bytes);
});

// Load the WHOLE pinned worker with real native error/abort/timeout helpers and
// the production preload. Page doubles execute the actual serialized DOM probe;
// there is no browser, account, network request, or model send in these tests.
async function runPinned(t, suite, patched) {
  const bytes = await fixture();
  const scratch = await mkdtemp(join(tmpdir(), 'native-browser-readiness-'));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
    assert.deepEqual(await readFile(entry), bytes, 'pinned bytes unchanged');
  });
  const payload = join(scratch, 'fixture-source.js');
  await writeFile(payload, patched ? await transform(bytes) : bytes);
  const script = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
const entry = ${JSON.stringify(entry)};
Bun.plugin({name:'offline-readiness-worker',setup(build){
  build.onLoad({filter:/[\\\\/]cli\\.js$/},({path})=>{
    assert.equal(resolve(path),entry);
    assert.equal(createHash('sha256').update(readFileSync(entry)).digest('hex'),${JSON.stringify(pin)});
    const source=readFileSync(${JSON.stringify(payload)},'utf8');
    const startup='Rk().catch((e)=>{process.stderr.write(\x60codex-chatgpt-web: \x24{e instanceof Error?e.message:String(e)}\\n\x60),process.exitCode=1});';
    assert.equal(source.split(startup).length,2,'CLI startup uniquely disabled');
    return {contents:source.replace(startup,'')+'\\nexport { Cs as Worker, q as AdapterError, Mi as ObservationError, BT as submittedTurnFailure, ff as chromium };',loader:'js'};
  });
}});
const native=await import(pathToFileURL(entry).href);
native.chromium.launch=()=>assert.fail('no browser launch');
native.chromium.connectOverCDP=()=>assert.fail('no CDP connection');
await (${suite.toString()})(native,${patched});
console.log('offline pinned readiness assertions passed');
`;
  const child = spawn(bun, ['run', '-'], {
    cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: join(scratch, 'app'),
      MAGPIE_NATIVE_BROWSER_CDP: '', MAGPIE_NATIVE_CHECKPOINT_HOME: '', CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS: '0' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  child.stdin.end(script);
  try {
    const result = await exit;
    assert.equal(result.code, 0, `Bun fixture failed (${result.signal}):\n${stdout}\n${stderr}`);
    assert.match(stdout, /offline pinned readiness assertions passed/);
    t.diagnostic(stdout.trim());
  } finally { clearTimeout(timer); }
}

for (const patched of [false, true]) test(`real pinned worker readiness (${patched ? 'production preload' : 'original control'})`, pinned, async t => {
  await runPinned(t, async ({ Worker, AdapterError, ObservationError, submittedTurnFailure }, patched) => {
    const challengeSrc = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/fixture';
    const makePage = (options = {}) => {
      const counters = { counts: 0, probes: 0, navigations: 0 };
      const composer = { fixtureComposer: true };
      const pageUrl = options.url ?? 'https://chatgpt.com/';
      const frames = (options.frames ?? [{ src: challengeSrc }]).map(spec => ({
        hidden: spec.hidden ?? false,
        parentElement: spec.hiddenParent ? { hidden: true, parentElement: null } : null,
        style: spec.style ?? {},
        getClientRects: () => spec.zeroSize ? [{ width: 0, height: 0 }] : [{ width: 300, height: 65 }],
        getAttribute: name => { assert.equal(name, 'src'); return spec.src; },
      }));
      const page = {
        url: () => pageUrl,
        goto: () => { counters.navigations++; assert.fail('no navigation during same-page verification'); },
        locator: () => ({ filter: ({ visible }) => {
          assert.equal(visible, true);
          return { count: async () => {
            counters.counts++;
            if (options.countError) throw options.countError;
            options.onCount?.();
            return options.counts?.[Math.min(counters.counts - 1, options.counts.length - 1)] ?? 0;
          }, first: () => composer };
        } }),
        evaluate: async callback => {
          counters.probes++;
          if (options.probe) return options.probe();
          const result = runInNewContext('(' + callback.toString() + ')()', {
            URL, location: new URL(pageUrl),
            document: {
              title: options.title ?? '请稍候…',
              body: { innerText: options.bodyText ?? '' },
              scripts: (options.scripts ?? []).map(spec => ({
                getAttribute: name => { assert.equal(name, 'src'); return spec.src ?? null; },
                textContent: spec.text ?? '',
              })),
              querySelectorAll: selector => { assert.equal(selector, 'iframe'); return frames; },
            },
            getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
          });
          return result;
        },
      };
      return { page, counters, composer };
    };
    const worker = Object.assign(Object.create(Worker.prototype), { config: { useTemporaryChats: false } });
    const isSecurity = error => error instanceof AdapterError && error.status === 403
      && error.errorType === 'permission_error' && error.code === 'chatgpt_security_check' && error.retryable === false;
    const isGeneric = error => !(error instanceof AdapterError) && /composer is unavailable/.test(error.message);

    // Positive control proves the original bug on the same fixture, while the
    // patched worker returns the native typed error before its existing deadline.
    for (const title of ['请稍候…', 'Just a moment...']) {
      const h = makePage({ title });
      await assert.rejects(worker.activeComposer(h.page, 80), patched ? isSecurity : isGeneric, title);
      assert.equal(h.counters.probes, patched ? 1 : 0);
      assert.equal(h.counters.navigations, 0);
    }
    const challengeScripts = [
      { src: '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1' },
      { text: 'window._cf_chl_opt={cUPMDTk:"/?__cf_chl_rt_tk=fixture"};' },
    ];
    for (const src of ['/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1', challengeSrc]) {
      const h = makePage({ frames: [], scripts: [{ src }, challengeScripts[1]] });
      await assert.rejects(worker.activeComposer(h.page, 80), patched ? isSecurity : isGeneric,
        'closed-shadow challenge: exact script plus inline marker, no DOM iframe');
    }
    if (patched) {
      const h = makePage();
      let error;
      try { await worker.prepareChatSurface(h.page); } catch (caught) { error = caught; }
      assert.ok(isSecurity(error), 'preparation propagates typed verification without auth handling');
      assert.equal(submittedTurnFailure({ runtime: { submission: { phase: 'prepared' } } }, error, {}), error);
      assert.equal(h.counters.probes, 1);
    }

    // No generic title, challenge-related prose, hidden/stale widget, other
    // origin, lookalike host, or bare title can prove human verification.
    for (const options of [
      { title: '' }, { title: 'ChatGPT' }, { title: 'Please verify you are human' },
      { title: 'Just a moment explaining Cloudflare' }, { frames: [] },
      { frames: [], bodyText: '<script src="/cdn-cgi/challenge-platform/a">__cf_chl_</script> 请验证您是真人' },
      { frames: [], scripts: [{ src: '' }, challengeScripts[1]] },
      { url: 'https://chatgpt.com/cdn-cgi/challenge-platform/page', frames: [], scripts: [challengeScripts[1]] },
      { frames: [], scripts: [challengeScripts[0]] },
      { frames: [], scripts: [challengeScripts[1]] },
      { frames: [], scripts: [{ src: challengeSrc }, { text: 'Please verify you are human' }] },
      { frames: [], scripts: [{ src: 'https://evil.invalid/cdn-cgi/challenge-platform/a' }, challengeScripts[1]] },
      { frames: [], scripts: [{ src: 'https://chatgpt.com.evil.invalid/cdn-cgi/challenge-platform/a' }, challengeScripts[1]] },
      { frames: [], scripts: [{ src: '/assets/challenge-platform/a' }, challengeScripts[1]] },
      { frames: [], scripts: [{ src: challengeSrc, text: '__cf_chl_' }] },
      { title: 'ChatGPT', frames: [], scripts: challengeScripts },
      { url: 'https://example.com/', frames: [], scripts: challengeScripts },
      { url: 'https://example.com/' }, { url: 'https://chatgpt.com.evil.invalid/' },
      { frames: [{ src: 'https://challenges.cloudflare.com.evil.invalid/cdn-cgi/challenge-platform/a' }] },
      { frames: [{ src: 'https://challenges.cloudflare.com/ordinary-frame' }] },
      { frames: [{ src: 'http://challenges.cloudflare.com/cdn-cgi/challenge-platform/a' }] },
      { frames: [{ src: null }] },
      { frames: [{ src: challengeSrc, hidden: true }] },
      { frames: [{ src: challengeSrc, hiddenParent: true }] },
      { frames: [{ src: challengeSrc, zeroSize: true }] },
      ...['none', 'hidden', '0'].map((value, i) => ({ frames: [{ src: challengeSrc,
        style: { [['display', 'visibility', 'opacity'][i]]: value } }] })),
    ]) {
      const h = makePage(options);
      await assert.rejects(worker.activeComposer(h.page, 15), isGeneric, JSON.stringify(options));
    }
    for (const counts of [[1], [2, 1], [0, 1]]) {
      const h = makePage({ title: 'ChatGPT', counts });
      assert.equal(await worker.activeComposer(h.page, 500), h.composer);
      assert.equal(h.counters.probes, patched && counts[0] === 0 ? 1 : 0);
    }
    const ambiguous = makePage({ counts: [2] });
    await assert.rejects(worker.activeComposer(ambiguous.page, 15), isGeneric);
    assert.equal(ambiguous.counters.probes, 0, 'multiple editors remain ordinary readiness ambiguity');
    const expired = makePage();
    await assert.rejects(worker.activeComposer(expired.page, 0), isGeneric);
    assert.equal(expired.counters.probes, 0, 'no observation after deadline');

    const abort = new AbortController();
    abort.abort();
    const cancelled = makePage();
    await assert.rejects(worker.activeComposer(cancelled.page, 30000, abort.signal), { name: 'AbortError' });
    assert.deepEqual(cancelled.counters, { counts: 0, probes: 0, navigations: 0 });
    const afterCount = new AbortController();
    const cancelledCount = makePage({ onCount: () => afterCount.abort() });
    await assert.rejects(worker.activeComposer(cancelledCount.page, 30000, afterCount.signal), { name: 'AbortError' });
    assert.equal(cancelledCount.counters.probes, 0);
    const observationFailure = new Error('page closed');
    await assert.rejects(worker.activeComposer(makePage({ countError: observationFailure }).page, 100), error => error === observationFailure);

    if (patched) {
      await assert.rejects(worker.activeComposer(makePage({ probe: () => { throw observationFailure; } }).page, 100), error => error === observationFailure);
      const navigationMessage = 'Execution context was destroyed, most likely because of a navigation';
      for (const prefix of ['', 'page.evaluate: ']) for (const suffix of ['', '.']) {
        const navigationError = new Error(prefix + navigationMessage + suffix);
        const recovering = makePage({ counts: [0, 1], probe: () => { throw navigationError; } });
        assert.equal(await worker.activeComposer(recovering.page, 500), recovering.composer);
        assert.deepEqual(recovering.counters, { counts: 2, probes: 1, navigations: 0 });
        const countFailure = makePage({ countError: navigationError });
        await assert.rejects(worker.activeComposer(countFailure.page, 500), error => error === navigationError);
        assert.equal(countFailure.counters.probes, 0, 'count failures never enter probe recovery');
      }
      const lookalikes = [
        new Error('Execution context was destroyed'), new Error('Cannot find context'),
        new Error('prefix ' + navigationMessage), new Error(navigationMessage + ' extra'),
        new Error(navigationMessage + '\n'), new Error(navigationMessage + '\r\n'),
        new Error('Page.evaluate: ' + navigationMessage), new Error(navigationMessage + '..'),
        new Error('page.evaluate: Target page, context or browser has been closed'),
        new TypeError(navigationMessage), new DOMException(navigationMessage, 'AbortError'),
        { name: 'Error', message: navigationMessage }, navigationMessage,
        new ObservationError(35),
      ];
      for (const failure of lookalikes) {
        const rejected = makePage({ counts: [0, 1], probe: () => { throw failure; } });
        await assert.rejects(worker.activeComposer(rejected.page, 500), error => error === failure);
        assert.equal(rejected.counters.counts, 1, 'only exact navigation errors resume polling');
      }
      const navigationAbort = new AbortController();
      const cancelledNavigation = makePage({ counts: [0, 1], probe: () => {
        navigationAbort.abort();
        throw new Error(navigationMessage);
      } });
      await assert.rejects(worker.activeComposer(cancelledNavigation.page, 500, navigationAbort.signal), { name: 'AbortError' });
      assert.equal(cancelledNavigation.counters.counts, 1, 'abort checked before polling again');
      const repeatedNavigation = makePage({ probe: () => { throw new Error(navigationMessage); } });
      const recoveryStarted = Date.now();
      await assert.rejects(worker.activeComposer(repeatedNavigation.page, 80), isGeneric);
      assert.ok(Date.now() - recoveryStarted < 1000, 'navigation recovery does not renew readiness budget');
      const started = Date.now();
      await assert.rejects(worker.activeComposer(makePage({ probe: () => new Promise(() => {}) }).page, 35), error => error instanceof ObservationError);
      assert.ok(Date.now() - started < 1000, 'hung probe bounded by remaining composer budget');
      const duringProbe = new AbortController();
      const pending = makePage({ probe: () => { duringProbe.abort(); return new Promise(() => {}); } });
      await assert.rejects(worker.activeComposer(pending.page, 60, duringProbe.signal), { name: 'AbortError' });
      const onResult = new AbortController();
      await assert.rejects(worker.activeComposer(makePage({ probe: () => { onResult.abort(); return true; } }).page,
        60, onResult.signal), { name: 'AbortError' });
    }
  }, patched);
});
