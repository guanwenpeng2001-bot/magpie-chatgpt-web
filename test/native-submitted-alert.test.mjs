import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';

// Only an explicit local test browser and a workspace runtime fixture. Never
// connect over CDP, discover an account, install, or execute CLI top-level code.
const entry = resolve(process.env.NATIVE_TERMINAL_CLI ?? join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js'));
const executablePath = process.env.NATIVE_TERMINAL_BROWSER || process.env.CHATGPT_DOM_TEST_BROWSER;
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const anchor = 'await this.reconcileMultipartHistory(e,t,i,r);let a=new Set([...n.acceptedTurnIdentities,...t.initialTurnIdentities])';
const initialAnchor = 'd=0,h=o?.snapshot();let g=Gi(u.initialTurnIdentities,m.responseIdentities);';
const initialObservationAnchor = 'let m;try{m=await this.submissionDomState(l,u.domCache,r),await this.reconcileMultipartHistory(l,u,m,r)}catch(w)';
const initialObservationPatch = 'let m,magpieSubmittedFailure;try{m=await this.submissionDomState(l,u.domCache,r),await this.reconcileMultipartHistory(l,u,m,r);try{await nativeSubmittedTerminalAlert(this,l,u,undefined,m,r,q,nativeTerminalErrorAlert)}catch(magpieProofError){if(magpieProofError instanceof Mi)throw magpieProofError;magpieSubmittedFailure={error:magpieProofError}}}catch(w)';
const initialFailureThrow = 'if(magpieSubmittedFailure)throw magpieSubmittedFailure.error;';
const stageAnchor = 'let V=await this.captureSubmissionBaseline(O,z.text,ze);';
const finalAnchor = 'let oe=await this.captureSubmissionBaseline(O,Be,ze,c.turnToken),ae=';

async function transform(bytes, checksum = pin) {
  let load;
  const source = compactionPreloadSource(entry)
    .replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '')
    .replace(`import { patchReferenceFixes } from ${JSON.stringify(new URL('../src/native/reference-fixes.mjs', import.meta.url).href)};`, '')
    .replace(pin, checksum);
  runInNewContext(source, { createHash, resolve, Buffer, TextDecoder, patchReferenceFixes,
    Bun: { plugin({ setup }) { setup({ onLoad(_options, callback) { load = callback; } }); },
      file(path) { assert.equal(path, entry); return { arrayBuffer: async () => Uint8Array.from(bytes).buffer }; } },
  });
  assert.equal(await load({ path: resolve('unrelated/cli.js') }), undefined);
  return (await load({ path: entry })).contents;
}

function section(source, start, end) {
  assert.equal(source.split(start).length, 2, `unique ${start}`);
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(b > a, `bounded ${start}`);
  return source.slice(a, b);
}

// Execute the actual transformed reconciliation, baseline, DOM observation,
// expansion, proof, normalization and original q/observation/abort classes.
// Extracting these declarations does not run the CLI or any browser launcher.
async function workerFrom(source, patched) {
  let imported = {};
  if (patched) {
    const match = source.match(/import \{ nativeSubmittedTerminalAlert, rememberNativeMultipartSubmission \} from ("[^"\n]+");/);
    assert.ok(match, 'actual preload imports the helper');
    imported = await import(JSON.parse(match[1]));
  }
  const functions = [
    section(source, 'var Sf=5000,mo=2;', 'class Mi'),
    section(source, 'class q extends Error{', 'function Ya('),
    section(source, 'class Mi extends Error{', 'async function Ye('),
    section(source, 'async function Ye(', 'async function C_('),
    section(source, 'function Ke(', 'function vf('),
    section(source, 'function Gi(', 'class Au{'),
    section(source, 'function E_(', 'async function vu('),
    section(source, 'function Sl(', 'import{createHash as nh}'),
    'var ' + section(source, 'co=[', 'var po='),
    'var ' + section(source, 'cc={', ',lc={') + ';',
    'var ' + section(source, 'wu=[', ',hn=') + ';',
    'var ' + section(source, "cu='", ',co=') + ';',
    section(source, 'var sh=[', '];') + '];',
    'var ' + section(source, 'xf=()=>', ';class Rf') + ';',
    section(source, 'function _t(){', 'function dl('),
    section(source, 'function S_(', 'function fo('),
    section(source, 'var Jn=6;function ki(', 'var Wx='),
    'var ' + section(source, 'Eu=(e)=>', 'async function Et('),
    section(source, 'async function Et(', 'var g_='),
    section(source, 'function hu(', 'function fu('),
    section(source, 'function Cu(', 'var xf='),
  ].join('\n');
  const methods = section(source, 'async submissionDomState(', 'async attachedPromptText(')
    + section(source, 'promptCodeUnitEquivalent(e,t,n){', 'promptEquivalentPrefixLength(e,t){')
    + section(source, 'async responseDomSnapshot(', 'async stalledTurnDiagnostic(');
  const detector = patched ? section(source, 'async function nativeTerminalErrorAlert(', 'import { checkpointStore') : '';
  // Run the actual transformed capture statements, including registration at the
  // formatter callsites. Tests do not manufacture a trusted baseline property.
  const stageCapture = section(source, patched ? 'let V=rememberNativeMultipartSubmission(' : stageAnchor, 'await this.runStage');
  const finalCapture = section(source, patched ? 'let oe=rememberNativeMultipartSubmission(' : finalAnchor.slice(0, -4), ',ae=') + ';';
  return runInNewContext(`${functions}\n${detector}\nclass Worker { ${methods} }
    async function captureStage(O,z,ze,A,E,c) { ${stageCapture} return V; }
    async function captureFinal(O,Be,ze,c,A,M) { ${finalCapture} return oe; }
    ({ Worker, AdapterError:q, ObservationError:Mi, selector:uo, stage:_r, commit:ao, captureStage, captureFinal, recoveryLimit:mo })`, {
    ...imported, af: createHash, setTimeout, clearTimeout, DOMException, $e: 3000,
    ys: 60000, P_: 5000, A_: 600000,
  });
}

const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const prompt = 'Compact the full conversation.\nPreserve  two spaces and the exact tail.';
const alert = '<aside role="alert">消息流中的错误</aside>';
const answer = '<div data-conversation-role="assistant"><div class="markdown">Earlier answer</div></div>';
const bubble = text => `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${escape(text)}</div></div>`;
const group = (key, text, suffix = '', prefix = '') => `<section data-turn-key="${key}">${prefix}${bubble(text)}${suffix}</section>`;

test('submitted terminal classification through the actual pinned preload', async t => {
  let bytes;
  try { bytes = await readFile(entry); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_TERMINAL_CLI) throw error;
    t.skip('pinned runtime absent; set NATIVE_TERMINAL_CLI to an existing v6.1.18 app/cli.js (never downloads)');
    return;
  }
  assert.equal(digest(bytes), pin);
  const raw = bytes.toString('utf8'), patched = await transform(bytes);
  assert.equal(raw.split(anchor).length, 2);
  assert.equal(patched.includes(anchor), false);
  const call = 'await nativeSubmittedTerminalAlert(this,e,t,n,i,r,q,nativeTerminalErrorAlert);';
  assert.equal(patched.split(call).length, 2);
  const fixed = await workerFrom(patched, true), original = await workerFrom(raw, false);

  await t.test('checksum, missing/duplicate anchor and unchanged original identity gate', async () => {
    await assert.rejects(transform(Buffer.from(raw + '\n')), /runtime checksum mismatch/);
    for (const replacement of ['', anchor + anchor]) {
      const drift = Buffer.from(raw.replace(anchor, replacement));
      await assert.rejects(transform(drift, digest(drift)), /Native submitted alert compatibility mismatch/);
    }
    for (const provenanceAnchor of [stageAnchor, finalAnchor]) {
      assert.equal(raw.split(provenanceAnchor).length, 2);
      for (const replacement of ['', provenanceAnchor + provenanceAnchor]) {
        const drift = Buffer.from(raw.replace(provenanceAnchor, replacement));
        await assert.rejects(transform(drift, digest(drift)), /Native submitted multipart provenance compatibility mismatch/);
      }
    }
    const formatterCall = 'A=c.multipart?`ctx_${ho().replaceAll("-","")}`:void 0,I=c.multipart&&A?c.multipart.parts.slice(0,-1).map((E,z)=>_r(E,A,z+1,c.multipart.parts.length)):void 0,M=c.multipart&&A?ao(c.multipart,A):void 0';
    assert.equal(raw.split(formatterCall).length, 2, 'fresh local transaction feeds both pinned formatters');
    const identityGate = 'd=t.acceptedUserIdentity?l===t.acceptedUserIdentity:Boolean(t.submittedText)&&await this.userMessageMatchesSubmission(h,t.submittedText,r,t.turnToken)';
    assert.equal(patched.split(identityGate).length, 2);
    assert.equal(patched.split(initialObservationPatch).length, 2);
    assert.equal(patched.split(initialFailureThrow).length, 2);
    for (const before of [initialAnchor, initialObservationAnchor]) {
      assert.equal(raw.split(before).length, 2);
      for (const replacement of ['', before + before]) {
        const drift = Buffer.from(raw.replace(before, replacement));
        await assert.rejects(transform(drift, digest(drift)), /Native initial submitted alert compatibility mismatch/);
      }
    }
    assert.equal(section(patched, 'async waitForNewAssistantTurn(', 'async reconcileAssistantTurnBinding(')
      .replace(initialObservationPatch, initialObservationAnchor).replace(initialFailureThrow, ''),
      section(raw, 'async waitForNewAssistantTurn(', 'async reconcileAssistantTurnBinding('),
      'initial wait unchanged except for proof-gated classification; no synthesized binding');
  });

  await t.test('isolated Chrome reconciliation fixtures', {
    skip: !executablePath && 'set NATIVE_TERMINAL_BROWSER (or CHATGPT_DOM_TEST_BROWSER) to installed Chrome',
  }, async t => {
  const { chromium } = createRequire(entry)('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let networkAttempts = 0;
    await context.route('**/*', route => { networkAttempts++; return route.abort(); });

    async function fixture({ history = '', submitted = prompt, accepted = 'optimistic', token, current,
      bound = 'optimistic', baselineText = submitted, setup, run = fixed, acceptedIdentities,
      acknowledgedStages = [], capture, baselineSetup } = {}) {
      const page = await context.newPage();
      const worker = new run.Worker(); worker.config = {};
      await page.setContent(`<main>${history}</main>`);
      let baseline = capture ? await capture(worker, page, baselineText, acknowledgedStages)
        : await worker.captureSubmissionBaseline(page, baselineText, acknowledgedStages, token);
      if (baselineSetup) baseline = await baselineSetup(baseline) ?? baseline;
      // A transient assistant shell establishes the binding before disappearing.
      // This does not simulate the uncovered wait before any assistant exists.
      await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, history + group(bound, submitted, '<div data-conversation-role="assistant"></div>'));
      const state = await worker.submissionDomState(page, {});
      baseline.acceptedUserIdentity = accepted === undefined ? undefined : `group:user:${accepted}`;
      const binding = { identity: `group:assistant:${bound}`, locator: page.locator(run.selector(`group:assistant:${bound}`)),
        acceptedTurnIdentities: acceptedIdentities ?? state.turnIdentities };
      await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, current ?? history + group('persisted', submitted, alert));
      if (setup) await setup(page, worker, baseline, binding);
      return { page, worker, baseline, binding, run, async reconcile(signal) {
        return worker.reconcileAssistantTurnBinding(page, baseline, binding, signal);
      } };
    }
    async function classify(options, expected, verify) {
      const f = await fixture(options);
      try {
        let result, error;
        try { result = await f.reconcile(); } catch (caught) { error = caught; }
        if (expected) {
          assert.ok(error instanceof f.run.AdapterError, error?.stack ?? 'expected terminal service error');
          assert.equal(error.code, 'upstream_server_error');
          assert.equal(error.status, 502); assert.equal(error.retryable, true);
        } else assert.equal(error instanceof f.run.AdapterError && error.code === 'upstream_server_error', false, error?.stack);
        await verify?.(f, result, error);
      } finally { await f.page.close(); }
    }

    await t.test('no assistant, stale accepted key, complete compaction text and preserved history', () => classify({
      history: group('old-1', 'Other request', answer) + group('old-2', 'Another request', answer),
    }, true));
    await t.test('already accepted user can be proven without a response identity', () => classify({
      accepted: 'persisted', acceptedIdentities: ['group:user:persisted', 'group:assistant:persisted'],
    }, true));
    await t.test('same root without assistant remains classifiable', () => classify({ current: group('optimistic', prompt, alert) }, true));
    // Shape corroborated by the sanitized Sol snapshot (2026-11-13 13:36 UTC).
    // Synthetic identities below exercise the gap; the snapshot does not prove
    // that the historical live root rekeyed.
    await t.test('Sol user-only root: exact Chinese alert plus ordinary retry, after its user', () => classify({
      current: group('persisted', prompt,
        '<div><div><div><aside role="alert">消息流中的错误<div><button>重试</button></div></aside></div></div></div>'),
      setup: async page => {
        const shape = await page.locator('[data-turn-key="persisted"]').evaluate(root => {
          const users = root.querySelectorAll('[data-user-message-bubble]'), alert = root.querySelector('[role="alert"]');
          return { users: users.length, assistants: root.querySelectorAll('[data-conversation-role="assistant"]').length,
            nearestOwnerIsRoot: alert.closest('[data-turn-key], [data-turn-id]') === root,
            afterUser: Boolean(users[0].compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING),
            visible: alert.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
            excluded: Boolean(alert.closest('[hidden], [inert], .markdown, [data-user-message-bubble]')),
            text: alert.innerText };
        });
        assert.deepEqual(shape, { users: 1, assistants: 0, nearestOwnerIsRoot: true, afterUser: true,
          visible: true, excluded: false, text: '消息流中的错误\n重试' });
      },
    }, true));
    await t.test('full-text proof also works without accepted user ID', () => classify({
      setup: async (_page, _worker, baseline) => { baseline.acceptedUserIdentity = undefined; },
    }, true));

    for (const [name, options] of [
      ['wrong full text', { current: group('persisted', 'Different request', alert) }],
      ['prefix only', { current: group('persisted', prompt.slice(0, 20), alert) }],
      ['changed whitespace', { current: group('persisted', prompt.replace('  ', ' '), alert) }],
      ['missing prepared proof', { baselineText: '' }],
      ['alert precedes user', { current: group('persisted', prompt, '', alert) }],
      ['global alert', { current: group('persisted', prompt) + alert }],
      ['history only', { history: group('history', prompt, alert), current: group('history', prompt, alert) }],
      ['history rekeyed into a matching error', { history: group('history', prompt, answer), current: group('persisted', prompt, alert) }],
      ['two matching candidates', { current: group('one', prompt, alert) + group('two', prompt, alert) }],
      ['competing different user', { current: group('persisted', prompt, alert) + group('foreign', 'Other', answer) }],
      ['surviving old root', { current: group('optimistic', prompt) + group('persisted', prompt, alert) }],
      ['hidden proof', { current: group('persisted', prompt, alert).replace('data-search-result-target', 'data-search-result-target hidden') }],
      ['hidden matching substring', { current: `<section data-turn-key="persisted"><div data-user-message-bubble><div data-search-result-target><span hidden>${escape(prompt)}</span></div></div>${alert}</section>` }],
      ['ambiguous user bubbles', { current: group('persisted', prompt, bubble(prompt) + alert) }],
      ['ambiguous content roots', { current: group('persisted', prompt, alert).replace('</div></div>', '<div data-search-result-target>Other</div></div></div>') }],
      ['unrecognized alert', { current: group('persisted', prompt, '<aside role="alert">Everything is fine</aside>') }],
      ['markdown alert', { current: group('persisted', prompt, `<div class="markdown">${alert}</div>`) }],
      ['hidden alert', { current: group('persisted', prompt, `<div hidden>${alert}</div>`) }],
      ['foreign nested alert', { current: group('persisted', prompt, `<article data-turn-id="foreign">${alert}</article>`) }],
    ]) await t.test(`abstain: ${name}`, () => classify(options, false));

    await t.test('identical known history is not selected instead of the current user', () => classify({
      history: group('history', prompt, alert), current: group('history', prompt, alert) + group('persisted', 'Wrong request'),
    }, false));
    await t.test('known historical duplicate does not defeat a unique current proof', () => classify({
      history: group('history', prompt, answer),
    }, true));

    const token = 'turn_' + 'a'.repeat(32), otherToken = 'turn_' + 'b'.repeat(32);
    for (const [name, shown, succeeds] of [
      ['exact original token', token, true], ['wrong token', otherToken, false],
      ['ambiguous token', `${token} ${token}`, false], ['token prefix', `${token}extra`, false],
      ['hidden token', `<span hidden>${token}</span>`, false],
    ]) await t.test(name, () => classify({ submitted: `Original ${token}`, token,
      current: `<section data-turn-key="persisted"><div data-user-message-bubble><div data-search-result-target>${shown}</div></div>${alert}</section>`,
    }, succeeds));

    const transaction = 'ctx_' + 'c'.repeat(32), otherTransaction = 'ctx_' + 'd'.repeat(32);
    const multipart = { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ records: [{ index, text: `Context part ${index + 1}` }] })),
      commit: 'Execute the supplied context.' };
    const stages = multipart.parts.slice(0, -1).map((part, index) => fixed.stage(part, transaction, index + 1, 6));
    const commit = fixed.commit(multipart, transaction);
    const completedStage = index => group(`stage-${index + 1}`, stages[index].text,
      `<div data-content-search-unit-key="answer-${index}"><div data-conversation-role="assistant"><div class="markdown">${escape(stages[index].acknowledgement)}</div></div></div><button data-testid="copy-turn-action-button">Copy</button>`);
    const records = count => stages.slice(0, count).map((stage, index) => ({ ...stage,
      identities: [`group:assistant:stage-${index + 1}-old`, `group:assistant:stage-${index + 1}`] }));
    const captureFinal = (worker, page, text, acknowledged) => fixed.captureFinal.call(worker, page, text, acknowledged,
      { multipart }, transaction, commit);
    const captureStage = index => (worker, page, _text, acknowledged) => fixed.captureStage.call(worker, page, stages[index],
      acknowledged, transaction, index, { multipart });
    const finalOptions = () => ({ submitted: commit, history: completedStage(3) + completedStage(4),
      acknowledgedStages: records(5), capture: captureFinal });

    await t.test('actual six-part commit capture: only last two stages mounted, earlier stages and old aliases absent', () => classify({
      ...finalOptions(), setup: async (page, worker, baseline) => {
        assert.ok(baseline.initialTurnIdentities.includes('group:assistant:stage-1'));
        assert.ok(baseline.initialTurnIdentities.includes('group:user:stage-1-old'));
        assert.equal(await page.locator('[data-turn-key]').count(), 3);
        assert.equal(await page.locator('[data-turn-key="stage-1"]').count(), 0);
        assert.equal(baseline.acknowledgedStages.length, 5);
        const snapshot = await worker.responseDomSnapshot(page.locator('[data-turn-key="stage-5"]'), {});
        assert.equal(snapshot.visibleText, stages[4].acknowledgement);
        assert.equal(snapshot.completionActionVisible, true);
      },
    }, true));
    await t.test('actual fourth-stage capture with first two acknowledged stages unmounted', () => classify({
      submitted: stages[3].text, history: completedStage(2), acknowledgedStages: records(3), capture: captureStage(3),
    }, true));
    await t.test('first-stage capture, empty history, vanished shell and exact no-tools service alert', () => classify({
      submitted: stages[0].text, capture: captureStage(0),
      current: group('persisted', stages[0].text, '<aside role="alert">出了点问题。请重试<div><button>重试</button></div></aside>'),
      setup: async (page, _worker, baseline) => {
        assert.equal(baseline.initialTurnIdentities.length, 0);
        assert.equal(await page.locator('[data-turn-key]').count(), 1);
        assert.equal(await page.locator('[role="alert"]').innerText(), '出了点问题。请重试\n重试');
      },
    }, true));
    await t.test('actual two-part transaction format and capture tolerate virtualized first stage', () => {
      const two = { ...multipart, parts: multipart.parts.slice(0, 2) }, stage = fixed.stage(two.parts[0], transaction, 1, 2);
      const text = fixed.commit(two, transaction);
      return classify({ submitted: text, acknowledgedStages: [{ ...stage, identities: ['group:assistant:unmounted'] }],
        capture: (worker, page, input, acknowledged) => fixed.captureFinal.call(worker, page, input, acknowledged, { multipart: two }, transaction, text),
      }, true);
    });
    for (const [name, shown, succeeds] of [
      ['exact prepared token', token, true], ['wrong prepared token', otherToken, false],
      ['token prefix', token + 'extra', false], ['ambiguous token', `${token} ${token}`, false],
    ]) await t.test(`virtualized history with ${name}`, () => classify({
      submitted: `Original ${token}`, token, history: group('old', 'Previous request', answer),
      current: group('persisted', shown, alert),
    }, succeeds));

    for (const [name, options] of [
      ['wrapper text without trusted capture registration', { capture: undefined }],
      ['wrong transaction at capture cannot register provenance', { capture: (worker, page, text, acknowledged) =>
        fixed.captureFinal.call(worker, page, text, acknowledged, { multipart }, otherTransaction, commit) }],
      ['different formatter output at capture cannot register provenance', { capture: (worker, page, text, acknowledged) =>
        fixed.captureFinal.call(worker, page, text, acknowledged, { multipart }, transaction, commit + 'changed') }],
      ['copied recovery baseline loses provenance', { baselineSetup: baseline => ({ ...baseline }) }],
      ['fabricated marker property cannot grant provenance', { capture: undefined, baselineSetup: baseline => {
        baseline.multipartTransactionId = transaction; baseline.nativeMultipartSubmission = true;
      } }],
      ['modified baseline text invalidates provenance', { baselineSetup: baseline => { baseline.submittedText += 'changed'; },
        current: completedStage(3) + completedStage(4) + group('persisted', commit + 'changed', alert) }],
      ['wrong transaction', { current: group('persisted', fixed.commit(multipart, otherTransaction), alert) }],
      ['wrong stage instead of commit', { current: group('persisted', stages[4].text, alert) }],
      ['prefix matching complete header only', { current: group('persisted', commit.slice(0, commit.indexOf('</codex_multipart_commit>')), alert) }],
      ['wrong payload tail with same nonce', { current: group('persisted', commit + 'changed', alert) }],
      ['hidden full text', { current: group('persisted', commit, alert).replace('data-search-result-target', 'data-search-result-target hidden') }],
      ['ambiguous user', { current: group('persisted', commit, bubble(commit) + alert) }],
      ['competing new root', { current: group('persisted', commit, alert) + group('foreign', 'Other') }],
      ['surviving old owner without assistant', { current: group('optimistic', commit) + group('persisted', commit, alert) }],
      ['surviving accepted user', { accepted: 'accepted', current: group('accepted', commit) + group('persisted', commit, alert) }],
    ]) await t.test(`virtualized multipart abstains: ${name}`, () => classify({ ...finalOptions(), ...options }, false));
    await t.test('known identical multipart history is excluded while current proof is wrong', () => classify({
      ...finalOptions(), history: completedStage(4) + group('duplicate-history', commit, alert),
      current: completedStage(4) + group('duplicate-history', commit, alert) + group('persisted', 'Wrong'),
    }, false));
    await t.test('another stage sharing the transaction nonce cannot prove the submitted stage', () => classify({
      submitted: stages[3].text, history: completedStage(2), acknowledgedStages: records(3), capture: captureStage(3),
      current: group('persisted', stages[2].text, alert),
    }, false));
    await t.test('still-present stale bound assistant bypasses reconciliation fallback (known limitation)', () => classify({
      current: group('optimistic', 'Stale visible response', answer) + group('persisted', prompt, alert),
    }, false, (f, result, error) => {
      assert.equal(error, undefined); assert.equal(result, f.binding);
    }));

    function expandable(text) {
      return `<section data-turn-key="persisted"><div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${escape(text.slice(0, 12))}</div><button type="button" aria-expanded="false" data-thread-find-skip="true" data-markdown-copy="exclude">Expand</button></div>${alert}</section>`;
    }
    const longPrompt = prompt + '\n' + 'intact context\n'.repeat(1000);
    const expansionSetup = (mutation, fullText = longPrompt) => async page => {
      await page.evaluate(({ text, mutation, competing }) => {
        const button = document.querySelector('button');
        let opens = 0;
        button.onclick = () => {
          const open = button.getAttribute('aria-expanded') === 'false';
          button.setAttribute('aria-expanded', String(open));
          document.querySelector('[data-search-result-target]').textContent = open ? text : text.slice(0, 12);
          if (open && ++opens === 1) {
            if (mutation === 'compete') document.querySelector('main').insertAdjacentHTML('beforeend', competing);
            if (mutation === 'wrong') document.querySelector('[data-search-result-target]').textContent += 'changed';
            if (mutation === 'rekey') document.querySelector('[data-turn-key]').setAttribute('data-turn-key', 'changed-key');
          }
        };
      }, { text: fullText, mutation, competing: group('foreign', 'Another task', answer) });
    };
    await t.test('expands full compaction text and restores expansion after the original adapter error', () => classify({
      submitted: longPrompt, current: expandable(longPrompt), setup: expansionSetup('none'),
    }, true, async f => { assert.equal(await f.page.locator('button').getAttribute('aria-expanded'), 'false'); }));
    await t.test('virtualized multipart commit still needs expansion to prove its complete text', () => classify({
      ...finalOptions(), current: expandable(commit), setup: expansionSetup('none', commit),
    }, true));
    await t.test('virtualized multipart rejects a competing turn introduced during expansion', () => classify({
      ...finalOptions(), current: expandable(commit), setup: expansionSetup('compete', commit),
    }, false));
    for (const mutation of ['compete', 'wrong', 'rekey']) await t.test(`abstain on expansion race: ${mutation}`, () => classify({
      submitted: longPrompt, current: expandable(longPrompt), setup: expansionSetup(mutation),
    }, false));

    await t.test('a mutation after the original proof cannot authorize the alert', () => classify({
      setup: async (page, worker) => {
        const actual = worker.userMessageMatchesSubmission;
        worker.userMessageMatchesSubmission = async function (...args) {
          const proof = await actual.apply(this, args);
          await page.locator('[data-search-result-target]').evaluate(node => { node.textContent = 'Foreign replacement'; });
          return proof;
        };
      },
    }, false));
    await t.test('replacement element with reused key during expansion is rejected', () => classify({
      submitted: longPrompt, current: expandable(longPrompt), setup: async page => {
        await expansionSetup('none')(page);
        await page.evaluate(() => {
          const button = document.querySelector('button'), handler = button.onclick;
          button.onclick = () => {
            handler();
            if (button.getAttribute('aria-expanded') === 'true') {
              const root = document.querySelector('[data-turn-key]'), clone = root.cloneNode(true);
              clone.querySelector('button').onclick = () => clone.querySelector('button').setAttribute('aria-expanded', 'false');
              root.replaceWith(clone);
            }
          };
        });
      },
    }, false));

    await t.test('normal reconciliation and original exceptions are unchanged', async () => {
      for (const current of [group('optimistic', prompt, answer), group('persisted', prompt, answer),
        group('optimistic', prompt, answer) + group('optimistic', prompt, answer),
        group('persisted', 'Wrong', answer), group('persisted', prompt), '']) {
        const outcomes = [];
        for (const run of [original, fixed]) {
          const f = await fixture({ current, run });
          try { const result = await f.reconcile(); outcomes.push({ identity: result.identity }); }
          catch (error) { outcomes.push({ name: error.name, message: error.message, code: error.code }); }
          finally { await f.page.close(); }
        }
        assert.deepEqual(outcomes[0], outcomes[1]);
      }
    });
    await t.test('user-only generation does not invoke the fallback expansion/proof', () => classify({
      current: group('persisted', prompt), setup: async (_page, worker) => {
        worker.withExpandedUserMessage = () => assert.fail('no alert: expansion must not run');
        worker.userMessageMatchesSubmission = () => assert.fail('no alert: proof must not run');
      },
    }, false, (_f, _result, error) => {
      assert.equal(error?.message, 'ChatGPT opened another user turn while the bound assistant response was detached');
    }));
    await t.test('even a reverted mutation after proof invalidates the witness', () => classify({
      setup: async (page, worker) => {
        const actual = worker.userMessageMatchesSubmission;
        worker.userMessageMatchesSubmission = async function (...args) {
          const proof = await actual.apply(this, args);
          await page.locator('[data-search-result-target]').evaluate(node => {
            const before = node.textContent; node.textContent = 'temporary foreign text'; node.textContent = before;
          });
          return proof;
        };
      },
    }, false));
    await t.test('abort and original observation exception identities survive', async () => {
      const f = await fixture();
      try {
        const abort = new AbortController(); abort.abort();
        await assert.rejects(f.reconcile(abort.signal), error => error instanceof DOMException && error.name === 'AbortError');
        const error = new fixed.ObservationError(1);
        f.worker.userMessageMatchesSubmission = async () => { throw error; };
        await assert.rejects(f.reconcile(), caught => caught === error);
      } finally { await f.page.close(); }
    });

    // Independent initial-wait gap. These fixtures never mount an assistant shell
    // or construct a binding. The live response-visible checkpoint is NOT evidence
    // for this path: its binding/proof history remains unknown.
    async function initialFixture({ history = '', submitted = prompt, token, current, accepted,
      run = fixed, capture, acknowledgedStages = [], setup } = {}) {
      const page = await context.newPage(), worker = new run.Worker(); worker.config = {};
      await page.setContent(`<main>${history}</main>`);
      const baseline = capture ? await capture(worker, page, submitted, acknowledgedStages)
        : await worker.captureSubmissionBaseline(page, submitted, acknowledgedStages, token);
      if (accepted) baseline.acceptedUserIdentity = `group:user:${accepted}`;
      await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, current ?? history + group('submitted', submitted, alert));
      if (setup) await setup(page, worker, baseline);
      return { page, worker, baseline, run, wait(signal, progress, grace = 0, tracker, recoverObservation) {
        return worker.waitForNewAssistantTurn(page, baseline, Date.now() + 10000, signal, progress, grace, tracker, recoverObservation);
      } };
    }
    async function initialCheck(options, terminal, ordinaryError = 'ChatGPT accepted the message but did not expose its assistant turn in the DOM') {
      const f = await initialFixture(options);
      try {
        await assert.rejects(f.wait(), error => {
          if (terminal) {
            assert.ok(error instanceof f.run.AdapterError, error.stack);
            assert.equal(error.code, 'upstream_server_error');
            assert.equal(error.status, 502); assert.equal(error.retryable, true);
          } else {
            // Assert the original ordinary DOM-grace verdict, not merely absence
            // of the new code (which could hide a harness/observation failure).
            assert.equal(error.message, ordinaryError);
          }
          return true;
        });
      } finally { await f.page.close(); }
    }
    await t.test('initial wait: raw pinned method misses a proven service alert, transformed method classifies it', async () => {
      await initialCheck({ run: original }, false);
      await initialCheck({}, true);
    });
    await t.test('initial wait: exact second Chinese alert, no tools, no assistant ever mounted', () => initialCheck({
      current: group('submitted', prompt, '<aside role="alert">出了点问题。请重试<div><button>重试</button></div></aside>'),
      setup: async (page, worker) => {
        const state = await worker.submissionDomState(page, {});
        assert.equal(state.responseIdentities.length, 0); assert.equal(state.visibleStopButtonCount, 0);
        worker.reconcileAssistantTurnBinding = () => assert.fail('initial classification must not invoke rebind authority');
      },
    }, true));
    await t.test('initial wait: exact prepared token despite unmounted older history', () => initialCheck({
      submitted: `Prepared ${token}`, token, history: group('old', 'History', answer), current: group('submitted', token, alert),
    }, true));
    await t.test('initial wait: stale accepted identity can classify only via original full-text proof', () => initialCheck({ accepted: 'unmounted' }, true));
    await t.test('initial wait: actual first-stage capture without any assistant binding', () => initialCheck({
      submitted: stages[0].text, capture: captureStage(0),
    }, true));
    await t.test('initial wait: trusted six-part commit with acknowledged history already virtualized', () => initialCheck(finalOptions(), true));

    for (const [name, options] of [
      ['different submitted user', { current: group('submitted', 'Different task', alert) }],
      ['prefix only', { current: group('submitted', prompt.slice(0, 20), alert) }],
      ['no submitted proof', { submitted: '' }],
      ['wrong prepared token', { submitted: `Prepared ${token}`, token, current: group('submitted', otherToken, alert) }],
      ['ambiguous token', { submitted: token, token, current: group('submitted', `${token} ${token}`, alert) }],
      ['historical alert only', { history: group('old', prompt, alert), current: group('old', prompt, alert) }],
      ['historical matching alert with wrong current user', { history: group('old', prompt, alert), current: group('old', prompt, alert) + group('submitted', 'Other', alert) }],
      ['vanished full-text history without nonce', { history: group('old', prompt, answer), current: group('submitted', prompt, alert) }],
      ['nonce-looking wrapper without trusted capture', { ...finalOptions(), capture: undefined }],
      ['two current matches', { current: group('submitted', prompt, alert) + group('competing', prompt, alert) }],
      ['competing different user', { current: group('submitted', prompt, alert) + group('competing', 'Other') }],
      ['surviving accepted owner', { accepted: 'old', history: group('old', 'Earlier'), current: group('old', 'Earlier') + group('submitted', prompt, alert) }],
      ['spoofed markdown alert', { current: group('submitted', prompt, `<div class="markdown">${alert}</div>`) }],
      ['spoofed user-content alert', { current: group('submitted', prompt + '消息流中的错误').replace('</div></div>', `${alert}</div></div>`) }],
      ['global alert', { current: group('submitted', prompt) + alert }],
      ['foreign alert owner', { current: group('submitted', prompt, `<article data-turn-id="foreign">${alert}</article>`) }],
      ['alert before user', { current: group('submitted', prompt, '', alert) }],
      ['hidden proof', { current: group('submitted', prompt, alert).replace('data-search-result-target', 'data-search-result-target hidden') }],
      ['hidden alert', { current: group('submitted', prompt, `<div hidden>${alert}</div>`) }],
      ['duplicate bubble', { current: group('submitted', prompt, bubble(prompt) + alert) }],
    ]) await t.test(`initial wait abstains: ${name}`, () => initialCheck(options, false));

    await t.test('initial wait: full-text expansion classifies and restores collapse', async () => {
      const f = await initialFixture({ submitted: longPrompt, current: expandable(longPrompt), setup: expansionSetup('none') });
      try {
        await assert.rejects(f.wait(), error => error instanceof f.run.AdapterError && error.code === 'upstream_server_error');
        assert.equal(await f.page.locator('button').getAttribute('aria-expanded'), 'false');
      } finally { await f.page.close(); }
    });
    for (const mutation of ['compete', 'wrong', 'rekey']) await t.test(`initial wait expansion race: ${mutation}`, () => initialCheck({
      submitted: longPrompt, current: expandable(longPrompt), setup: expansionSetup(mutation),
    }, false, mutation === 'rekey' ? 'ChatGPT removed the message expansion control during verification' : undefined));
    for (const mutation of ['replace', 'revert', 'compete']) await t.test(`initial wait witness rejects mutation after proof: ${mutation}`, () => initialCheck({
      setup: async (page, worker) => {
        const actual = worker.userMessageMatchesSubmission;
        worker.userMessageMatchesSubmission = async function (...args) {
          const proof = await actual.apply(this, args);
          await page.locator('[data-turn-key]').evaluate((root, mutation) => {
            if (mutation === 'replace') root.replaceWith(root.cloneNode(true));
            if (mutation === 'compete') { const clone = root.cloneNode(true); clone.setAttribute('data-turn-key', 'competing'); root.after(clone); }
            if (mutation === 'revert') { root.setAttribute('hidden', ''); root.removeAttribute('hidden'); }
          }, mutation);
          return proof;
        };
      },
    }, false));
    await t.test('initial wait: live external progress cannot swallow terminal error or acknowledge a tool boundary', async () => {
      const f = await initialFixture();
      try {
        f.worker.waitForTurnDomOrExternalProgress = () => assert.fail('terminal error must not become a progress wait');
        const progress = { snapshot: () => ({ revision: 1, activeToolCalls: 1, lastProgressAt: Date.now(), lastToolBatchRevision: 1 }),
          acknowledgeToolBatch: () => assert.fail('error classification must not acknowledge tools') };
        await assert.rejects(f.wait(undefined, progress, 10000, { needsToolBatchObservation: () => true,
          observeToolBatch: () => assert.fail('error classification must not observe tools') }),
        error => error instanceof f.run.AdapterError && error.code === 'upstream_server_error');
      } finally { await f.page.close(); }
    });
    const liveProgress = () => ({ snapshot: () => ({ revision: 7, activeToolCalls: 1,
      lastProgressAt: Date.now(), lastToolBatchRevision: 1 }),
      acknowledgeToolBatch: () => assert.fail('failed proof must not acknowledge tools') });
    const noToolTracker = { needsToolBatchObservation: () => true,
      observeToolBatch: () => assert.fail('failed proof must not observe tools') };
    await t.test('initial proof timeout uses original recovery callback even with live external progress', async () => {
      const f = await initialFixture(), timeout = new fixed.ObservationError(1), recoveredBaseline = { ...f.baseline, domCache: {} };
      try {
        const actual = f.worker.userMessageMatchesSubmission;
        let proofs = 0, recoveries = 0;
        f.worker.userMessageMatchesSubmission = async function (...args) {
          if (++proofs === 1) throw timeout;
          return actual.apply(this, args);
        };
        f.worker.waitForTurnDomOrExternalProgress = () => assert.fail('recovery takes precedence over liveness wait');
        await assert.rejects(f.wait(undefined, liveProgress(), 10000, noToolTracker, async (attempt, error, baseline, signal) => {
          assert.equal(++recoveries, 1); assert.equal(attempt, 1); assert.equal(error, timeout);
          assert.equal(baseline, f.baseline); assert.equal(signal, undefined);
          return { page: f.page, baseline: recoveredBaseline };
        }), error => error instanceof fixed.AdapterError && error.code === 'upstream_server_error');
        assert.equal(proofs, 2); assert.equal(recoveries, 1);
      } finally { await f.page.close(); }
    });
    await t.test('persistent initial proof timeouts exhaust the pinned two-recovery bound despite live progress', async () => {
      const f = await initialFixture(), timeout = new fixed.ObservationError(1);
      try {
        let proofs = 0; const attempts = [];
        f.worker.userMessageMatchesSubmission = async () => { proofs++; throw timeout; };
        f.worker.waitForTurnDomOrExternalProgress = () => assert.fail('bounded recovery must not fall into progress wait');
        await assert.rejects(f.wait(undefined, liveProgress(), 10000, noToolTracker, async (attempt, error, baseline) => {
          attempts.push(attempt); assert.equal(error, timeout); assert.equal(baseline, f.baseline);
          return { page: f.page, baseline };
        }), error => {
          assert.equal(error.message, 'ChatGPT accepted the message, but its DOM remained unresponsive after 2 same-page rebinds');
          assert.equal(error.cause, timeout); return true;
        });
        assert.equal(f.run.recoveryLimit, 2);
        assert.deepEqual(attempts, [1, 2]); assert.equal(proofs, 3);
      } finally { await f.page.close(); }
    });
    await t.test('initial proof timeout without recovery waits for live external progress then retries fresh proof', async () => {
      const f = await initialFixture(), timeout = new fixed.ObservationError(1);
      try {
        const actual = f.worker.userMessageMatchesSubmission, progress = liveProgress();
        let proofs = 0, waits = 0;
        f.worker.userMessageMatchesSubmission = async function (...args) {
          if (++proofs === 1) throw timeout;
          return actual.apply(this, args);
        };
        f.worker.waitForTurnDomOrExternalProgress = async (page, revision, external, signal) => {
          assert.equal(++waits, 1); assert.equal(page, f.page); assert.equal(revision, 7);
          assert.equal(external, progress); assert.equal(signal, undefined);
        };
        await assert.rejects(f.wait(undefined, progress, 10000, noToolTracker),
          error => error instanceof fixed.AdapterError && error.code === 'upstream_server_error');
        assert.equal(proofs, 2); assert.equal(waits, 1);
      } finally { await f.page.close(); }
    });
    await t.test('initial proof timeout escapes unchanged when external progress is stale and recovery absent', async () => {
      const f = await initialFixture(), timeout = new fixed.ObservationError(1);
      try {
        f.worker.userMessageMatchesSubmission = async () => { throw timeout; };
        f.worker.waitForTurnDomOrExternalProgress = () => assert.fail('stale progress must not suppress a timeout');
        await assert.rejects(f.wait(undefined, { snapshot: () => ({ revision: 1, activeToolCalls: 0, lastProgressAt: Date.now() - 60000 }) }, 10000),
          error => error === timeout);
      } finally { await f.page.close(); }
    });
    await t.test('recovered baseline is used for proof; old proof cannot authorize changed submission', async () => {
      const f = await initialFixture(), timeout = new fixed.ObservationError(1);
      try {
        const actual = f.worker.userMessageMatchesSubmission;
        let proofs = 0;
        f.worker.userMessageMatchesSubmission = async function (...args) {
          if (++proofs === 1) throw timeout;
          assert.equal(args[1], 'Changed submitted request');
          return actual.apply(this, args);
        };
        await assert.rejects(f.wait(undefined, undefined, 0, undefined, async () => ({ page: f.page,
          baseline: { ...f.baseline, submittedText: 'Changed submitted request', domCache: {} } })),
        error => error.message === 'ChatGPT accepted the message but did not expose its assistant turn in the DOM');
        assert.equal(proofs, 2);
      } finally { await f.page.close(); }
    });
    await t.test('authenticated initial error bypasses supplied recovery and live progress before tool acknowledgement', async () => {
      const f = await initialFixture();
      try {
        f.worker.waitForTurnDomOrExternalProgress = () => assert.fail('terminal error must not wait');
        await assert.rejects(f.wait(undefined, liveProgress(), 10000, noToolTracker,
          () => assert.fail('terminal error must not recover observation')),
        error => error instanceof fixed.AdapterError && error.code === 'upstream_server_error');
      } finally { await f.page.close(); }
    });
    for (const [name, failure] of [['abort', new DOMException('Aborted during proof', 'AbortError')],
      ['ordinary exception', new Error('Proof fixture failure')], ['falsy thrown value', undefined]]) {
      await t.test(`non-observation proof failure escapes recovery/progress unchanged: ${name}`, async () => {
        const f = await initialFixture();
        try {
          f.worker.userMessageMatchesSubmission = async () => { throw failure; };
          f.worker.waitForTurnDomOrExternalProgress = () => assert.fail('non-observation failure must not wait');
          let caught = false;
          try { await f.wait(undefined, liveProgress(), 10000, noToolTracker,
            () => assert.fail('non-observation failure must not recover')); }
          catch (error) { caught = true; assert.equal(error, failure); }
          assert.equal(caught, true);
        } finally { await f.page.close(); }
      });
    }
    await t.test('initial wait: ordinary assistant binding and acceptance are unchanged', async () => {
      for (const current of [group('submitted', prompt, answer), group('submitted', 'Normal reference selection', answer)]) {
        const outcomes = [];
        for (const run of [original, fixed]) {
          const f = await initialFixture({ run, current });
          try {
            f.worker.userMessageMatchesSubmission = () => assert.fail('normal assistant selection must not invoke fallback proof');
            const result = await f.wait();
            outcomes.push({ identity: result.identity, turns: Array.from(result.acceptedTurnIdentities), count: await result.locator.count() });
          } finally { await f.page.close(); }
        }
        assert.deepEqual(outcomes[0], outcomes[1]);
      }
    });
    await t.test('initial wait: user-only ordinary generation continues until a natural assistant appears', async () => {
      const f = await initialFixture({ current: group('submitted', prompt) });
      try {
        let waits = 0;
        f.worker.withExpandedUserMessage = () => assert.fail('no alert must not expand');
        f.worker.waitForTurnDomOrExternalProgress = async () => {
          assert.equal(++waits, 1);
          await f.page.locator('[data-turn-key]').evaluate((root, html) => root.insertAdjacentHTML('beforeend', html), answer);
        };
        const result = await f.wait(undefined, undefined, 10000);
        assert.equal(result.identity, 'group:assistant:submitted'); assert.equal(waits, 1);
      } finally { await f.page.close(); }
    });
    await t.test('initial wait: original abort and observation exception identities survive', async () => {
      const f = await initialFixture();
      try {
        const abort = new AbortController(); abort.abort();
        await assert.rejects(f.wait(abort.signal), error => error instanceof DOMException && error.name === 'AbortError');
        const observation = new fixed.ObservationError(1);
        f.worker.userMessageMatchesSubmission = async () => { throw observation; };
        await assert.rejects(f.wait(), error => error === observation);
      } finally { await f.page.close(); }
    });
    assert.equal(networkAttempts, 0, 'fixtures never attempted network requests');
  } finally { await browser.close(); }
  });
  assert.deepEqual(await readFile(entry), bytes, 'pinned CLI remains unchanged');
});
