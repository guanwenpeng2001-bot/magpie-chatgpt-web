import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';

const entry = resolve(process.env.NATIVE_REFERENCE_CLI
  ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/app/cli.js', import.meta.url)));
const bun = resolve(process.env.NATIVE_REFERENCE_BUN
  ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/runtime/bun.exe', import.meta.url)));
const patchModule = new URL('../src/native/reference-fixes.mjs', import.meta.url).href;
const pinnedHash = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
// The standard suite needs neither sibling fixtures, Bun nor Chrome. Explicit
// opt-in must FAIL on absent/incompatible prerequisites, never silently skip.
const pinned = { skip: process.env.NATIVE_REFERENCE_FIXES_SMOKE !== '1', timeout: 90_000 };
let fixture;
function readPinnedFixture() {
  return fixture ??= (async () => {
    const bytes = await readFile(entry);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pinnedHash);
    return { bytes, original: bytes.toString('utf8') };
  })();
}

test('reference patch rejects non-source and missing anchors without runtime dependencies', () => {
  assert.throws(() => patchReferenceFixes(Buffer.from('source')), TypeError);
  assert.throws(() => patchReferenceFixes(''), /anchor mismatch/);
});

test('all five exact anchors reject drift, duplicates, and repeat application', pinned, async () => {
  const { bytes, original } = await readPinnedFixture();
  const sites = [
    ['await this.insertPromptText(e,t,o),', ';return}let l=await this.selectConnector(e,r,i,a,o);'],
    ['async insertPromptText(e,t,n){', '}async verifyConnectorExclusive'],
    ['for(let F of Array.from(S.querySelectorAll(".chart-widget-container,', 'F.remove();'],
    ['let c=(g)=>/^<environment_context>\\s*<current_date>', '.exec(g),l=[]'],
    ['async function ma(e,t={}){', 'var Ab=600000'],
  ];
  for (const [start, end] of sites) {
    const at = original.indexOf(start);
    assert.ok(at >= 0);
    const through = original.indexOf(end, at);
    assert.ok(through > at);
    const anchor = original.slice(at, through + end.length);
    assert.equal(original.split(anchor).length, 2);
    assert.throws(() => patchReferenceFixes(original.replace(start, start.replace(start[0], '?'))), /anchor mismatch/);
    assert.throws(() => patchReferenceFixes(original.replace(anchor, () => anchor + anchor)), /anchor mismatch/);
  }
  assert.throws(() => patchReferenceFixes(patchReferenceFixes(original)), /anchor mismatch/);
  assert.throws(() => patchReferenceFixes(bytes), TypeError);
  // Caller edits unrelated to these ports are retained. Replacement must not
  // interpret $&, $`, or $' embedded in injected JavaScript as replacement tokens.
  assert.ok(patchReferenceFixes(original + '\n// unrelated preload patch').endsWith('// unrelated preload patch'));
  assert.ok(patchReferenceFixes(original).includes('await this.insertPromptText(e,` ${t}`,o)'));
});

test('preload composition checks original bytes before the reference patches', pinned, async () => {
  const { bytes } = await readPinnedFixture();
  const { compactionPreloadSource } = await import('../src/native/runtime.mjs');
  const preload = compactionPreloadSource(entry);
  // Exercise the documented integration without editing runtime.mjs. Also work
  // after the owning agent integrates that same import/call into the preload.
  const referenceImport = `import { patchReferenceFixes } from ${JSON.stringify(patchModule)};`;
  let script = preload.replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '');
  if (script.includes(referenceImport)) script = script.replace(referenceImport, '');
  else {
    const marker = "return { contents, loader: 'js' };";
    assert.equal(script.split(marker).length, 2);
    script = script.replace(marker, "return { contents: patchReferenceFixes(contents), loader: 'js' };");
  }
  async function load(input) {
    let onLoad, referenceCalls = 0;
    runInNewContext(script, { createHash, resolve, Buffer, TextDecoder,
      patchReferenceFixes(source) { referenceCalls++; return patchReferenceFixes(source); },
      Bun: { plugin({ setup }) { setup({ onLoad(_filter, callback) { onLoad = callback; } }); },
        file() { return { arrayBuffer: async () => Uint8Array.from(input).buffer }; } },
    });
    try { return { result: await onLoad({ path: entry }), referenceCalls }; }
    catch (error) { assert.equal(referenceCalls, 0, 'bad bytes rejected before patching'); throw error; }
  }
  const { result, referenceCalls } = await load(bytes);
  assert.equal(referenceCalls, 1);
  assert.equal(result.loader, 'js');
  assert.ok(result.contents.includes('function replacePlainTextInComposer('));
  assert.ok(result.contents.includes('function removeMermaidPreviewShells('));
  assert.ok(result.contents.includes('launchNativeBrowser(ff,'), 'existing preload edits retained');
  await assert.rejects(load(Buffer.concat([bytes, Buffer.from('\n')])), /runtime checksum mismatch/);
});

// Load the WHOLE real bundle, with its shipped dependencies and actual methods.
// Only disable the unique CLI entry call and expose native bindings for tests.
// No copied implementations, install, daemon, live CDP endpoint, or account.
async function runPinned(t, suite) {
  const { bytes } = await readPinnedFixture();
  const scratch = await mkdtemp(join(tmpdir(), 'native-reference-fixes-'));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
    assert.deepEqual(await readFile(entry), bytes, 'installed pinned bundle is unchanged');
  });
  const script = `
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { patchReferenceFixes } from ${JSON.stringify(patchModule)};
const entry = ${JSON.stringify(entry)};
const scratch = ${JSON.stringify(scratch)};
Bun.plugin({name:'isolated-reference-fixture',setup(build){
  build.onLoad({filter:/[\\\\/]cli\\.js$/}, ({path})=>{
    assert.equal(resolve(path),resolve(entry));
    const bytes=readFileSync(path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),${JSON.stringify(pinnedHash)});
    const source=patchReferenceFixes(bytes.toString('utf8'));
    const startup='Rk().catch((e)=>{process.stderr.write(\x60codex-chatgpt-web: \x24{e instanceof Error?e.message:String(e)}\\n\x60),process.exitCode=1});';
    assert.equal(source.split(startup).length,2,'unique CLI startup disabled');
    return {contents:source.replace(startup,'')+'\\nexport { Cs as Worker, ff as chromium, CC as convert, Rl as MarkdownBuffer, ma as probe, Vu as Store, Fn as parseRequest, Zl as calendarDelta, Oh as remember, ue as identity, zt as summaryPrefix };',loader:'js'};
  });
}});
const native=await import(pathToFileURL(entry).href);
await (${suite.toString()})(native,scratch);
console.log('reference fixture passed');
`;
  const child = spawn(bun, ['run', '-'], {
    cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: join(scratch, 'app'), CODEX_HOME: scratch,
      MAGPIE_NATIVE_BROWSER_CDP: '', MAGPIE_NATIVE_CHECKPOINT_HOME: '',
      CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS: '0' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill(), 75_000);
  child.stdin.end(script);
  try {
    const result = await exit;
    assert.equal(result.code, 0, `Bun fixture failed (${result.signal}):\n${stdout}\n${stderr}`);
    assert.match(stdout, /reference fixture passed/);
    t.diagnostic(stdout.trim());
  } finally { clearTimeout(timeout); }
}

test('real composer, Mermaid snapshot/buffer, and capability methods in isolated Chrome', pinned, async t => {
  await runPinned(t, async ({ Worker, chromium, convert, MarkdownBuffer, probe }) => {
    const browser = await chromium.launch({
      ...(process.env.NATIVE_REFERENCE_BROWSER ? { executablePath: process.env.NATIVE_REFERENCE_BROWSER } : { channel: 'chrome' }), headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const worker = Object.assign(Object.create(Worker.prototype), { config: { appName: 'Codex Native2' } });
      const prompt = '# Heading\n**bold** `code`\n```js\nx = 1;\n```\n' + 'Task context\n'.repeat(5000) + 'request_id: current';
      for (const text of [prompt, 'Bigger Context stage part 2\n```\nexact stage\n```']) {
        await page.setContent('<form><div id="prompt-textarea" contenteditable="true" style="min-height:40px">old draft</div></form>');
        await page.locator('#prompt-textarea').evaluate(element => {
          const native = document.execCommand.bind(document);
          window.edits = [];
          document.execCommand = (command, ui, value) => {
            window.edits.push({ command, before: element.textContent, selection: window.getSelection().toString() });
            return native(command, ui, value);
          };
          element.addEventListener('input', () => {
            if (element.textContent === '') {
              element.textContent = 'restored stale draft';
              const range = document.createRange();
              range.selectNodeContents(element); range.collapse(true);
              const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            }
          });
        });
        await worker.attachPrompt(page, text, false);
        assert.equal(await worker.attachedPromptText(page), text);
        const edits = await page.evaluate(() => window.edits);
        assert.deepEqual(edits, [{ command: 'insertText', before: 'restored stale draft', selection: 'restored stale draft' }]);
        // setContent does not reset the Window; reset the overridden command.
        await page.goto('about:blank');
      }
      for (const modern of [false, true]) for (const stale of ['', 'earlier request']) {
        const pill = modern
          ? '<span app-mention-path="app://fixture" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span>'
          : '<span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span>';
        await page.setContent('<form><div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div></form>'
          + '<div id="mention-menu" hidden><div class="__menu-item" tabindex="0" data-highlighted><span>Codex Native2</span></div></div>');
        await page.locator('#prompt-textarea').evaluate((element, { pill, stale }) => {
          element.innerHTML = pill;
          element.appendChild(document.createTextNode(stale ? ' ' + stale : ''));
          const menu = document.querySelector('#mention-menu');
          element.addEventListener('input', () => { menu.hidden = element.textContent !== '@codex'; });
          element.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !menu.hidden) { event.preventDefault(); element.innerHTML = pill; menu.hidden = true; }
          });
        }, { pill, stale });
        await worker.attachPrompt(page, 'connector request', true);
        assert.equal(await worker.attachedPromptText(page), 'connector request');
        assert.equal(await worker.connectorIsSelected(page.locator('#prompt-textarea')), true);
      }
      const controller = new AbortController(); controller.abort(new Error('fixture abort'));
      await assert.rejects(worker.insertPromptText(page, 'must not insert', controller.signal, true), /prompt attachment aborted/);
      assert.equal(await worker.attachedPromptText(page), 'connector request');
      // Use the actual inserted callback, with an unfocusable element; its false
      // return must reach the native editing-command rejection path.
      await page.setContent('<div id="unfocusable">preserve</div>');
      const rejectionWorker = Object.assign(Object.create(Worker.prototype), { activeComposer: async () => ({
        focus: async () => {}, evaluate: (fn, value) => page.locator('#unfocusable').evaluate(fn, value),
      }) });
      await assert.rejects(rejectionWorker.insertPromptText(page, 'erase', undefined, true), /rejected the plain-text editing command/);
      assert.equal(await page.locator('#unfocusable').textContent(), 'preserve');
      console.log('composer: restored drafts, stage payload, both connector pills, abort/focus refusal passed');

      const preview = '<div data-chatgpt-mermaid-preview><div data-block-actions="true" data-markdown-copy="exclude">'
        + '<button>Diagram options</button></div><div data-code-block-preview-pane="mermaid"><svg><text>Node A</text></svg></div></div>';
      await page.setContent('<section id="turn"><div class="markdown"><p>Opening prose.</p><h2>Architecture</h2>' + preview
        + '<pre><code class="language-mermaid">graph TD;\nA--&gt;B;</code></pre><h2>Decomposition</h2><p>Committed explanation.</p><p>Final paragraph.</p></div></section>');
      const initial = await worker.responseDomSnapshot(page.locator('#turn'));
      assert.equal(initial.responsePresent, true);
      assert.ok(!initial.fullHtml.includes('data-chatgpt-mermaid-preview'));
      assert.match(convert(initial.fullHtml), /```mermaid\ngraph TD;\nA-->B;\n```/);
      const buffer = new MarkdownBuffer(undefined, 0);
      const emitted = buffer.observe(initial.markdownSegments, 0);
      assert.match(emitted, /Committed explanation/);
      await page.locator('[data-chatgpt-mermaid-preview]').evaluate(node => node.replaceWith(node.cloneNode(true), node.cloneNode(true)));
      const remounted = await worker.responseDomSnapshot(page.locator('#turn'));
      assert.equal(buffer.observe(remounted.markdownSegments, 1), '');
      assert.equal(buffer.finish().markdown, convert(initial.fullHtml));
      assert.equal(await page.locator('[data-chatgpt-mermaid-preview]').count(), 2, 'cleanup changes clones only');
      for (const code of [
        '<pre><code class="language-mermaid">flowchart LR\nX--&gt;Y</code></pre>',
        '<div data-markdown-copy="code-block"><code class="language-mermaid">flowchart LR\nX--&gt;Y</code></div>',
        '<div data-markdown-copy="code-block"><div class="cm-content" data-language="mermaid"><div class="cm-line">flowchart LR</div><div class="cm-line">X--&gt;Y</div></div></div>',
      ]) {
        await page.setContent('<section id="turn"><div class="markdown"><div data-chatgpt-mermaid-preview>'
          + '<div data-block-actions="true" data-markdown-copy="exclude">Diagram options</div>' + code + '</div></div></section>');
        const snapshot = await worker.responseDomSnapshot(page.locator('#turn'));
        assert.equal(convert(snapshot.fullHtml), '```mermaid\nflowchart LR\nX-->Y\n```');
      }
      await page.setContent('<section id="turn"><div class="markdown"><pre><code><span data-chatgpt-mermaid-preview>literal marker</span></code></pre></div></section>');
      assert.match(convert((await worker.responseDomSnapshot(page.locator('#turn'))).fullHtml), /literal marker/);
      console.log('Mermaid: remount alignment, streamed buffer, separate/wrapped/CodeMirror/literal code passed');

      async function picker({ ghost = false, locked = false, invalid = false, open = false } = {}) {
        await page.setContent('<form><div id="prompt-textarea" contenteditable="true">Ready</div>'
          + '<button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="effort" aria-expanded="false" data-state="closed">Effort</button></form>'
          + '<div id="effort" role="menu" hidden><div data-model-reasoning-effort-slider>'
          + Array.from({ length: 5 }, (_, i) => `<span data-selected="${i === 2}" ${invalid ? '' : `data-locked="${locked && i >= 3}"`}>tick</span>`).join('')
          + '<span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span></div></div>');
        await page.evaluate(({ ghost, open }) => {
          const button = document.querySelector('button'), menu = document.querySelector('#effort');
          window.events = [];
          const state = shown => { button.setAttribute('aria-expanded', String(shown)); button.dataset.state = shown ? 'open' : 'closed'; };
          button.addEventListener('click', () => { window.events.push('click'); state(true); if (!ghost) menu.hidden = false; });
          button.addEventListener('pointerdown', event => {
            if (!event.isTrusted) { window.events.push('pointerdown'); state(true); menu.hidden = false; }
          });
          document.addEventListener('keydown', event => {
            if (event.key === 'Escape') { window.events.push('Escape'); state(false); menu.hidden = true; }
            if (event.key === 'Enter') { window.events.push('Enter'); event.preventDefault(); }
          }, { once: false });
          if (open) { state(true); menu.hidden = false; }
        }, { ghost, open });
      }
      for (const options of [{}, { ghost: true }, { locked: true }, { open: true }]) {
        await page.goto('about:blank'); await picker(options);
        assert.deepEqual(await probe(page, { settleMs: 20 }), {
          solAvailable: true, extraHighAvailable: !options.locked, proAvailable: !options.locked,
        });
        const events = await page.evaluate(() => window.events);
        assert.deepEqual(events, options.ghost ? ['click', 'Escape', 'pointerdown', 'Escape'] : options.open ? ['Escape'] : ['click', 'Escape']);
        assert.equal(await page.locator('#effort').isVisible(), false);
      }
      await page.goto('about:blank'); await picker({ ghost: true, invalid: true });
      let captured = false;
      await assert.rejects(probe(page, { settleMs: 20, onFailureBeforeCleanup: async error => {
        assert.match(error.message, /slider ticks/);
        assert.equal(await page.locator('#effort').isVisible(), true);
        captured = true;
      } }), /slider ticks/);
      assert.equal(captured, true);
      assert.equal(await page.locator('#effort').isVisible(), false);
      captured = false;
      await assert.rejects(probe(page, { signal: controller.signal, onFailureBeforeCleanup: async () => { captured = true; } }), /fixture abort/);
      assert.equal(captured, true);
      console.log('capabilities: click, ghost/pointer fallback, already-open, locked ticks, failure-before-Escape, abort passed');
    } finally { await browser.close(); }
  });
});

test('real calendar extraction and rollout store retain authority for UUID inventories', pinned, async t => {
  await runPinned(t, async ({ Store, parseRequest, calendarDelta, remember, identity, summaryPrefix }, scratch) => {
    const root = join(scratch, 'workspace'); mkdirSync(root);
    const thread = '01a06c66-4232-7ae1-9108-69b5f70e0671';
    const turn = '01a06c66-4380-75c6-a0df-318f890ef6de';
    const oldTurn = '01a06c66-18ad-73e1-a641-9b114f2ed10c';
    const rollout = join(scratch, 'sessions', '2026', '09', '04', `rollout-2026-09-04T15-30-36-${thread}.jsonl`);
    mkdirSync(dirname(rollout), { recursive: true });
    const disabled = '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>';
    const readOnly = '<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>';
    const validInventories = [
      '', '<subagents></subagents>', '<subagents><agent name="/root/reviewer" /></subagents>',
      '<subagents>- 00000000-0000-0000-0000-000000000001</subagents>',
      '<subagents>\n    - 00000000-0000-0000-0000-000000000001\n    - 00000000-0000-0000-0000-000000000002: Worker\n  </subagents>',
      '<subagents>\r\n\t- ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF: Reviewer /root/name\r\n</subagents>',
    ];
    const malformedInventories = [
      '<subagents>- not-a-uuid: Worker</subagents>',
      '<subagents>- 00000000-0000-0000-0000-000000000001 <cwd>/unexpected</cwd></subagents>',
      '<subagents><agent name="bad" cwd="/unexpected" /></subagents>',
      '<subagents><agent name="worker" />\n- 00000000-0000-0000-0000-000000000001</subagents>',
      '<subagents>- 00000000-0000-0000-0000-000000000001\npermission: unrestricted</subagents>',
      '<subagents>-00000000-0000-0000-0000-000000000001</subagents>',
      '<subagents>- 00000000-0000-0000-0000-000000000001: Worker\n<permission_profile type="disabled" /></subagents>',
    ];
    const message = (id, text, kinds = ['environments.environment_context'], idTurn = turn) => ({
      type: 'message', role: 'user', id, content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: idTurn, content_item_kinds: kinds },
    });
    for (const mode of ['danger-full-access', 'read-only', 'workspace-write']) {
      const managed = mode !== 'danger-full-access';
      const canWrite = mode === 'workspace-write';
      const profile = !managed ? disabled : canWrite
        ? readOnly.replace('</file_system>', `<entry access="write"><path>${root}</path></entry></file_system>`)
        : readOnly;
      const permissionProfile = !managed ? { type: 'disabled' } : {
        type: 'managed', file_system: { type: 'restricted', entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          ...(canWrite ? [{ path: { type: 'path', path: root }, access: 'write' }] : []),
        ] }, network: 'restricted',
      };
      const nativeContext = { type: 'turn_context', payload: { turn_id: turn, cwd: root, workspace_roots: [root],
        approval_policy: 'never', sandbox_policy: { type: mode, ...(managed ? { network_access: false } : {}), ...(canWrite ? { writable_roots: [root], exclude_slash_tmp: true, exclude_tmpdir_env_var: true } : {}) },
        permission_profile: permissionProfile, model: 'chatgpt-web/pro', summary: 'auto' } };
      const saveRollout = () => writeFileSync(rollout, [
        { type: 'session_meta', payload: { id: thread, source: 'vscode' } }, nativeContext,
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
      saveRollout();
      const envelope = inventory => `<environment_context><current_date>2026-10-21</current_date><timezone>America/New_York</timezone><filesystem><workspace_roots><root>${root}</root></workspace_roots>${profile}</filesystem>${inventory}</environment_context>`;
      for (const format of ['plain', 'v1', 'v2']) {
        const body = { model: 'chatgpt-web/high', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({
          request_kind: 'turn', thread_id: thread, turn_id: turn, agent_name: '/root', sandbox_mode: mode, workspaces: { [root]: {} },
        }) }, input: [message('instruction', 'Inspect workspace', ['user.text'])] };
        let request = parseRequest(body);
        if (format !== 'plain') {
          body.input[0].internal_chat_message_metadata_passthrough.turn_id = oldTurn;
          const summary = `${mode} ${format} checkpoint`;
          request = parseRequest(body);
          remember({ ...request, _compactionRequest: true }, identity(request), [{ turnId: oldTurn, content: body.input[0].content }], summary);
          body.input.unshift(message('base', `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots>${profile}</filesystem></environment_context>`));
          body.input.push(format === 'v1' ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${summaryPrefix}\n${summary}` }] }
            : { type: 'compaction', encrypted_content: 'ocx1:' + Buffer.from(summary).toString('base64') });
        }
        const delta = message('midnight', envelope(validInventories[3])); body.input.push(delta);
        request = parseRequest(body);
        const store = new Store(undefined, Date.now, scratch);
        for (const inventory of validInventories) {
          delta.content[0].text = envelope(inventory);
          const result = store.resolve(request);
          assert.equal(result.cwd, root);
          assert.equal(result.sandboxPolicy.type, managed ? canWrite ? 'workspaceWrite' : 'readOnly' : 'dangerFullAccess');
          if (managed) assert.equal(result.sandboxPolicy.networkAccess, false);
        }
        const valid = envelope(validInventories[3]);
        for (const invalid of [
          ...malformedInventories.map(envelope),
          valid.replaceAll(root, join(scratch, 'foreign')),
          valid.replace('</workspace_roots>', `<root>${join(scratch, 'extra')}</root></workspace_roots>`),
          valid.replace(profile, managed ? disabled : readOnly),
          valid.replace('</environment_context>', '<cwd>/unexpected</cwd></environment_context>'),
          valid.replace('</filesystem>', disabled + '</filesystem>'),
          valid.replace('</permission_profile>', '<network>enabled</network></permission_profile>'),
          ...(managed ? [valid.replace('access="read"', 'access="write"')] : []),
        ]) {
          delta.content[0].text = invalid;
          assert.throws(() => store.resolve(request), undefined, `${mode}/${format} accepted ${invalid}`);
        }
        delta.content[0].text = valid;
        const metadata = delta.internal_chat_message_metadata_passthrough;
        for (const wrong of [undefined, { ...metadata, turn_id: oldTurn }]) {
          delta.internal_chat_message_metadata_passthrough = wrong;
          assert.equal(calendarDelta(request, format === 'plain' ? undefined : { afterEnvironmentIndex: 0 }), undefined,
            'unattributed/foreign turn text cannot be a calendar claim');
          // Continuation handling also has a separately proven base envelope;
          // test attribution at the calendar recognizer, not that other path.
          if (wrong === undefined && format === 'plain') assert.throws(() => store.resolve(request));
        }
        delta.internal_chat_message_metadata_passthrough = metadata;
        const id = delta.id; delete delta.id;
        assert.equal(calendarDelta(request, format === 'plain' ? undefined : { afterEnvironmentIndex: 0 }), undefined);
        if (format === 'plain') assert.throws(() => store.resolve(request));
        delta.id = id;
        assert.equal(store.resolve(request).cwd, root);
        nativeContext.payload.turn_id = oldTurn; saveRollout();
        assert.throws(() => store.resolve(request), undefined, 'cached state cannot override stale rollout');
        nativeContext.payload.turn_id = turn; saveRollout();
        rmSync(rollout);
        assert.throws(() => store.resolve(request), undefined, 'UUID inventory cannot replace native rollout proof');
        saveRollout();
        console.log(`calendar: ${mode}/${format} UUID/name/empty inventories and authority rejection matrix passed`);
      }
    }
  });
});
