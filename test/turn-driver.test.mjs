import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard, BackendError } from '../backend/guard.mjs';
import { translate } from '../src/wire/translate.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { AnswerStream } from '../src/wire/translate.mjs';
import { siteAdapterHtml } from '../integrations/turn-fixture.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Bridge } from '../src/bridge.mjs';
import { serve } from '../backend/main.mjs';
import { prepare } from '../src/wire/prepare.mjs';

const command = (extra = {}) => ({ auth: { profile: 'fixture', refresh: 'next-auth.session-token=fixture' }, model: 'auto', history: [{ role: 'user', content: 'first' }], ...extra });
const guard = () => new AccountGuard({ sleep: async () => {} });
function harness(options = {}) {
  const calls = [];
  const pages = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages,
    cookies: async () => [{ name: 'next-auth.session-token', value: 'fixture' }],
    exposeBinding: async () => {}, addInitScript: async () => {},
    async newCDPSession() {
      return {
        async send(method) {
          if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { left: 80, top: 80, width: 1280, height: 900 } };
          return {};
        },
        async detach() {},
      };
    },
    async newPage() {
      const page = {
        closed: false, isClosed() { return this.closed; },
        async close() { this.closed = true; calls.push('close'); },
        async bringToFront() { calls.push('front'); },
        async goto() { calls.push('navigate'); },
        async evaluate(fn, value) {
          if (typeof value?.network === 'boolean') calls.push(['network', value.network]);
          if (typeof value?.model === 'string') calls.push(['wire-model', value.model]);
        },
        locator() { return { filter() { return this; }, async fill(text) { calls.push(['fill', text]); }, async press() { calls.push('submit'); } }; },
      };
      pages.push(page);
      return page;
    },
    async close() { for (const page of pages) await page.close(); this.emit('close'); },
  });
  const adapter = {
    async assertTemporaryChat() { calls.push('temporary'); return true; },
    async probePageError() { calls.push('probe'); return null; },
    async readComposer() { calls.push('composer'); return { ok: true }; },
    async selectModel() { calls.push('model'); return { ok: true }; },
    async submitPrompt() { calls.push('submit'); return { ok: true }; },
    async waitForReady() {},
    async attachImages(page, images) { calls.push(['images', images]); return { ok: true }; },
    ...options.adapter,
  };
  const driver = new TurnDriver({ profileRoot: '/fixture', launch: async () => context, adapter,
    observe: async () => ({ text: 'answer', route: 'dom' }), ...options, adapter });
  const complete = (request = command(), accountGuard = guard(), signal = new AbortController().signal) => {
    const frames = [];
    return driver.complete(request, accountGuard, 'fixture', signal, frame => frames.push(frame)).then(result => ({ frames, result }));
  };
  return { driver, calls, pages, context, complete };
}

function trackBackground(driver) {
  const calls = [];
  const setBackground = driver.browser.setBackground.bind(driver.browser);
  driver.browser.setBackground = async (...args) => {
    calls.push(args[1]);
    return setBackground(...args);
  };
  return calls;
}

test('real page interstitial takes precedence over rate limit and sign-in', async t => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; t.skip('playwright-core is not installed'); return; }
  const root = await mkdtemp(join(tmpdir(), 'turn-precedence-'));
  const driver = new TurnDriver({ profileRoot: root, challengeTimeout: 20, launch: async (profile, options) => {
    const context = await chromium.launchPersistentContext(profile, { ...options, serviceWorkers: 'block' });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: siteAdapterHtml({ challenge: 'title', rate: 'Rate limit', signIn: true, composer: 'none' }) }));
    return context;
  } });
  try {
    await assert.rejects(driver.complete(command(), guard(), 'fixture', new AbortController().signal, () => {}), { code: 'verification' });
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});

test('rendered DOM supersedes stream markdown in AnswerStream', () => {
  const answer = new AnswerStream();
  answer.accept({ event: 'answer', data: { text: '**bold**' } });
  answer.accept({ event: 'dom', data: { text: 'bold', complete: true } });
  answer.finish();
  assert.equal(answer.text, 'bold');
});

test('a marker-only Web action is repaired in the same ChatGPT page before completion', async () => {
  const prepared = prepare({
    model: 'auto',
    messages: [{ role: 'user', content: 'Inspect this project.' }],
    tools: [{
      name: 'exec_command',
      input_schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false,
      },
    }],
    conversation_id: 'repair-action',
  });
  let observations = 0;
  const h = harness({
    observe: async (page, { emit }) => {
      observations++;
      if (observations === 1) {
        await emit({ event: 'dom', data: { text: prepared.start } });
        return { text: prepared.start, route: 'dom' };
      }
      assert.match(h.calls.filter(call => Array.isArray(call) && call[0] === 'fill').at(-1)[1], /omitted the required JSON/);
      return {
        text: '{"name":"exec_command","input":{"cmd":"Get-ChildItem"}}',
        route: 'dom',
      };
    },
  });
  try {
    const { frames, result } = await h.complete(command(prepared));
    assert.equal(result.repaired, true);
    assert.equal(result.text, `${prepared.start}{"name":"exec_command","input":{"cmd":"Get-ChildItem"}}${prepared.end}`);
    assert.deepEqual(frames, [
      { type: 'delta', index: 0, text: `${prepared.start}{"name":"exec_command","input":{"cmd":"Get-ChildItem"}}${prepared.end}` },
      { type: 'finish', reason: 'complete' },
    ]);
    assert.equal(h.calls.filter(call => call === 'submit').length, 2);
  } finally {
    await h.driver.close();
  }
});

for (const partial of ['', '{"name":"exec_command","input":{"cmd":"BROKEN']) test(`repair preserves prose and replaces unfinished JSON: ${partial.length}`, async () => {
  const prepared = prepare({ model: 'auto', messages: [{ role: 'user', content: 'Inspect files.' }],
    tools: [{ name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }], conversation_id: 'partial-repair' });
  let attempts = 0;
  const h = harness({ observe: async (page, { emit }) => {
    if (++attempts === 1) {
      const text = `I will inspect. ${prepared.start}${partial}`;
      await emit({ event: 'dom', data: { text } });
      return { text };
    }
    // The first correction violates the original schema, so the second is needed.
    return { text: attempts === 2 ? '{"name":"exec_command","input":{"cmd":7}}' : '{"name":"exec_command","input":{"cmd":"dir"}}' };
  } });
  try {
    const { frames, result } = await h.complete(command(prepared));
    assert.equal(attempts, 3);
    assert.equal(result.text, `I will inspect. ${prepared.start}{"name":"exec_command","input":{"cmd":"dir"}}${prepared.end}`);
    assert.equal(frames.filter(frame => frame.type === 'delta').map(frame => frame.text).join(''), result.text);
    assert.equal(frames.at(-1).type, 'finish');
    assert.equal(result.text.includes('BROKEN'), false);
  } finally { await h.driver.close(); }
});

test('a revised buffered envelope is emitted once with its canonical arguments', async () => {
  const p = prepare({ model: 'auto', messages: [{ role: 'user', content: 'Inspect.' }], tools: [{ name: 'run', input_schema: { type: 'object' } }] });
  const full = `Prose. ${p.start}{"name":"run","input":{"new":true}}${p.end}`;
  const h = harness({ observe: async (page, { emit }) => {
    await emit({ event: 'dom', data: { text: `Prose. ${p.start}{"old":` } });
    await emit({ event: 'dom', data: { text: `Prose. ${p.start}{"name":"missing","input":{}}${p.end}` } });
    await emit({ event: 'dom', data: { text: full } });
    return { text: full };
  } });
  try {
    const { frames } = await h.complete(command(p));
    assert.deepEqual(frames.filter(frame => frame.type === 'delta').map(frame => frame.text), ['Prose. ', full.slice(7)]);
  } finally { await h.driver.close(); }
});

test('failed tool validation emits no successful finish and releases binding', async () => {
  const p = prepare({ model: 'auto', messages: [{ role: 'user', content: 'Inspect.' }], tools: [{ name: 'run', input_schema: { type: 'object', required: ['cmd'] } }], conversation_id: 'invalid-output' });
  const h = harness({ observe: async () => ({ text: `${p.start}{"name":"run","input":{}}${p.end}` }) });
  const frames = [];
  try {
    await assert.rejects(h.driver.complete(command(p), guard(), 'fixture', new AbortController().signal, frame => frames.push(frame)), { code: 'toolSchema' });
    assert.equal(frames.some(frame => frame.type === 'finish'), false);
    assert.equal(h.driver.bindings.entries.has('invalid-output'), false);
  } finally { await h.driver.close(); }
});

test('incremental image turns upload only suffix images; a closed page replays all', async () => {
  const image = value => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(value).toString('base64') } });
  const first = { role: 'user', content: [image('old')] };
  const second = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture', content: [image('new')] }] };
  const messages = [first];
  const prepareImages = () => prepare({ model: 'auto', conversation_id: 'images-resume', messages: [...messages] });
  const h = harness();
  try {
    await h.complete(command(prepareImages()));
    messages.push({ role: 'assistant', content: 'answer' }, second);
    const next = prepareImages();
    assert.deepEqual(next.imageHistoryIndices, [0, 2]);
    await h.complete(command(next));
    assert.deepEqual(h.calls.filter(call => Array.isArray(call) && call[0] === 'images').map(call => call[1].map(image => Buffer.from(image.dataBase64, 'base64').toString())), [['old'], ['new']]);
    await h.pages[0].close();
    messages.push({ role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' });
    await h.complete(command(prepareImages()));
    assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'images').at(-1)[1].length, 2);
  } finally { await h.driver.close(); }
});

test('a failed first action repair gets one bounded second correction attempt', async () => {
  const prepared = prepare({
    model: 'auto',
    messages: [{ role: 'user', content: 'Inspect this project.' }],
    tools: [{
      name: 'exec_command',
      input_schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
      },
    }],
    conversation_id: 'repair-action-retry',
  });
  let observations = 0;
  const h = harness({
    observe: async () => {
      observations++;
      if (observations === 1) return { text: prepared.start, route: 'dom' };
      if (observations === 2) throw new BackendError('empty');
      return { text: '{"name":"exec_command","input":{"cmd":"Get-ChildItem"}}', route: 'dom' };
    },
  });
  try {
    const { result } = await h.complete(command(prepared));
    assert.equal(result.repaired, true);
    assert.equal(h.calls.filter(call => call === 'submit').length, 3);
    assert.match(
      h.calls.filter(call => Array.isArray(call) && call[0] === 'fill').at(-1)[1],
      /Return the JSON object itself/,
    );
  } finally {
    await h.driver.close();
  }
});

test('tool repair never overrides an explicit no-tool choice', async () => {
  const prepared = prepare({
    model: 'auto',
    messages: [{ role: 'user', content: 'Answer without a tool.' }],
    tools: [{
      name: 'exec_command',
      input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
    }],
    tool_choice: { type: 'none' },
    conversation_id: 'repair-none',
  });
  let observations = 0;
  const h = harness({
    observe: async () => {
      observations++;
      return { text: prepared.start, route: 'dom' };
    },
  });
  try {
    await assert.rejects(h.complete(command(prepared)), { code: 'toolIncomplete' });
    assert.equal(observations, 1);
    assert.equal(h.calls.filter(call => call === 'submit').length, 1);
  } finally {
    await h.driver.close();
  }
});

test('cancellation interrupts an in-flight action repair and releases the binding', async () => {
  const prepared = prepare({
    model: 'auto',
    messages: [{ role: 'user', content: 'Inspect this project.' }],
    tools: [{
      name: 'exec_command',
      input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
    }],
    conversation_id: 'repair-cancel',
  });
  let repairStarted;
  const started = new Promise(resolve => { repairStarted = resolve; });
  let observations = 0;
  const h = harness({
    observe: async (page, { signal }) => {
      observations++;
      if (observations === 1) return { text: prepared.start, route: 'dom' };
      repairStarted();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const controller = new AbortController();
  const request = h.complete(command(prepared), guard(), controller.signal);
  const rejected = assert.rejects(request, { code: 'upstream' });
  try {
    await started;
    controller.abort();
    await rejected;
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.driver.bindings.entries.has('repair-cancel'), false);
  } finally {
    await h.driver.close();
  }
});

test('a concurrent request cannot take the same conversation while repair is running', async () => {
  const prepared = prepare({
    model: 'auto',
    messages: [{ role: 'user', content: 'Inspect this project.' }],
    tools: [{
      name: 'exec_command',
      input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
    }],
    conversation_id: 'repair-busy',
  });
  let repairStarted;
  let releaseRepair;
  const started = new Promise(resolve => { repairStarted = resolve; });
  const held = new Promise(resolve => { releaseRepair = resolve; });
  let observations = 0;
  const h = harness({
    observe: async () => {
      observations++;
      if (observations === 1) return { text: prepared.start, route: 'dom' };
      repairStarted();
      await held;
      return { text: '{"name":"exec_command","input":{"cmd":"Get-ChildItem"}}', route: 'dom' };
    },
  });
  const first = h.complete(command(prepared));
  try {
    await started;
    await assert.rejects(h.complete(command(prepared)), { code: 'binding' });
    releaseRepair();
    assert.equal((await first).result.repaired, true);
  } finally {
    releaseRepair();
    await h.driver.close();
  }
});

test('driver compiles history, attaches images and returns normalized rendered output', async () => {
  const image = { mediaType: 'image/png', dataBase64: 'eA==', bytes: 1 };
  const h = harness();
  try {
    const { frames, result } = await h.complete(command({ images: [image] }));
    assert.deepEqual(h.calls.filter(value => typeof value === 'string').slice(0, 7), ['navigate', 'probe', 'temporary', 'probe', 'composer', 'model', 'submit']);
    assert.deepEqual(h.calls.find(value => value[0] === 'images'), ['images', [image]]);
    assert.deepEqual(h.calls.find(value => value[0] === 'fill'), ['fill', '[Human]\nfirst']);
    assert.deepEqual(frames, [{ type: 'delta', index: 0, text: 'answer' }, { type: 'finish', reason: 'complete' }]);
    assert.equal(result.route, 'dom');
  } finally { await h.driver.close(); }
});

test('visible browser turns read the rendered answer without parsing hidden intermediate stream messages', async () => {
  const h = harness();
  try {
    await h.complete(command({ visibleTurns: true }));
    assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'network'), ['network', false]);
  } finally { await h.driver.close(); }
});

test('browser observation emits incremental assistant deltas before finish', async () => {
  const h = harness({
    observe: async (page, { emit }) => {
      await emit({ event: 'answer', data: { text: 'incremental ' } });
      await emit({ event: 'answer', data: { text: 'answer' } });
      return { text: 'incremental answer', route: 'dom' };
    },
  });
  try {
    const { frames } = await h.complete(command({ visibleTurns: true }));
    assert.deepEqual(frames, [
      { type: 'delta', index: 0, text: 'incremental ' },
      { type: 'delta', index: 0, text: 'answer' },
      { type: 'finish', reason: 'complete' },
    ]);
  } finally { await h.driver.close(); }
});

test('request-only catalogue IDs reach the page harvester with their exact original model', async () => {
  const h = harness();
  try {
    await h.complete(command({ model: 'gpt-5-6-mini' }));
    assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'wire-model'), ['wire-model', 'gpt-5-6-mini']);
  } finally { await h.driver.close(); }
});

test('Work models initialize the saved-task surface and never masquerade as temporary chats', async () => {
  let initialized = 0;
  const h = harness({ adapter: {
    initializeWorkPage: async () => { initialized++; },
    assertTemporaryChat: async () => assert.fail('Work must not claim temporary-chat semantics'),
  } });
  try {
    await h.complete(command({ model: 'gpt-6-luna-wm' }));
    assert.equal(initialized, 1);
    assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'network'), ['network', false]);
  } finally { await h.driver.close(); }
});

for (const [kind, code, detail] of [
  ['picker-missing', 'pickerMissing', { component: 'picker', selector: '[picker]', adapterVersion: 'fixture' }],
  ['picker-ambiguous', 'pickerAmbiguous', { slug: 'model', count: 2 }],
  ['model-not-offered', 'modelNotOffered', { slug: 'model' }],
]) test(`picker ${kind} maps to ${code} with populated slots`, async () => {
  const h = harness({ adapter: { selectModel: async () => ({ ok: false, kind, detail }) } });
  try { await assert.rejects(h.complete(), error => error.code === code && !/\{\w+\}/.test(error.message)); }
  finally { await h.driver.close(); }
});

test('prefix-matching second turn sends only new history', async () => {
  const h = harness();
  try {
    await h.complete(command({ conversationKey: 'session' }));
    await h.complete(command({ conversationKey: 'session', history: [...command().history, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'second' }] }));
    assert.deepEqual(h.calls.filter(value => value[0] === 'fill'), [['fill', '[Human]\nfirst'], ['fill', '[Human]\nsecond']]);
    assert.equal(h.pages.length, 1);
  } finally { await h.driver.close(); }
});

test('equal-length resume index is rejected before compilation', async () => {
  let compiled = false;
  const h = harness({ prompter: () => { compiled = true; return 'bad'; } });
  h.driver.bindings.take = async () => ({ entry: {}, resumeFrom: 1 });
  try {
    await assert.rejects(h.complete(), { code: 'binding' });
    assert.equal(compiled, false);
  } finally { await h.driver.close(); }
});

for (const [kind, code] of [['challenge', 'verification'], ['rate-limit', 'cooldown'], ['sign-in', 'expired']]) test(`page ${kind} blocks composer and maps to ${code}`, async () => {
  const h = harness({ challengeTimeout: 20, adapter: { probePageError: async () => ({ kind }) } });
  const accountGuard = guard();
  try {
    await assert.rejects(h.complete(command(), accountGuard), { code });
    assert.equal(h.calls.includes('composer'), false);
    if (kind === 'sign-in') await assert.rejects(accountGuard.begin(), { code: 'expired' });
    if (kind === 'rate-limit') await assert.rejects(accountGuard.begin(), { code: 'cooldown' });
  } finally { await h.driver.close(); }
});

test('a pre-submit challenge reveals the same context, waits for recovery, and returns it to the background', async () => {
  let probes = 0;
  const h = harness({
    challengeTimeout: 250,
    adapter: { probePageError: async () => ++probes <= 2 ? { kind: 'challenge' } : null },
  });
  const backgrounds = trackBackground(h.driver);
  try {
    const { result } = await h.complete(command({ conversationKey: 'recover-before-submit' }));
    assert.equal(result.text, 'answer');
    assert.deepEqual(backgrounds, [false, true]);
    assert.equal(h.calls.filter(call => call === 'submit').length, 1);
    assert.equal(h.pages.length, 1);
    assert.equal(h.pages[0].isClosed(), false);
  } finally { await h.driver.close(); }
});

test('a post-submit challenge resumes observation without submitting twice', async () => {
  let observations = 0;
  let recovering = false;
  let recoveryProbes = 0;
  const h = harness({
    challengeTimeout: 250,
    adapter: { probePageError: async () => recovering && ++recoveryProbes === 1 ? { kind: 'challenge' } : null },
    observe: async () => {
      if (++observations === 1) {
        recovering = true;
        throw new BackendError('verification');
      }
      return { text: 'recovered answer', route: 'dom' };
    },
  });
  const backgrounds = trackBackground(h.driver);
  try {
    const { result } = await h.complete(command({ conversationKey: 'recover-after-submit' }));
    assert.equal(result.text, 'recovered answer');
    assert.deepEqual(backgrounds, [false, true]);
    assert.equal(h.calls.filter(call => call === 'submit').length, 1);
    assert.equal(h.pages.length, 1);
  } finally { await h.driver.close(); }
});

test('a recovery deadline preserves the visible page and the next request resumes without resubmitting', async () => {
  let readyCalls = 0;
  const h = harness({
    timeout: 60,
    challengeTimeout: 60,
    adapter: {
      probePageError: async () => ({ kind: 'challenge' }),
      waitForReady: async (page, { signal }) => {
        if (++readyCalls === 1) return;
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
  });
  const backgrounds = trackBackground(h.driver);
  const request = command({ conversationKey: 'recovery-deadline' });
  try {
    await assert.rejects(h.complete(request), { code: 'verification' });
    assert.equal(h.pages[0].isClosed(), false);
    assert.equal(h.driver.bindings.entries.get('recovery-deadline').busy, false);
    h.driver.adapter.probePageError = async () => null;
    h.driver.adapter.waitForReady = async () => {};
    const { result } = await h.complete(request);
    assert.equal(result.text, 'answer');
    assert.deepEqual(backgrounds, [false, false, true]);
    assert.equal(h.calls.filter(call => call === 'submit').length, 1);
    assert.equal(h.pages.length, 1);
  } finally { await h.driver.close(); }
});

test('a keyless challenge does not retain an unreachable page after the deadline', async () => {
  let readyCalls = 0;
  const h = harness({
    timeout: 60,
    challengeTimeout: 60,
    adapter: {
      probePageError: async () => ({ kind: 'challenge' }),
      waitForReady: async (page, { signal }) => {
        if (++readyCalls === 1) return;
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
  });
  try {
    await assert.rejects(h.complete(command()), { code: 'verification' });
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.driver.bindings.entries.size, 0);
  } finally { await h.driver.close(); }
});

test('a deadline after recovery preserves the submitted page for the next observation attempt', async () => {
  let probes = 0;
  let observations = 0;
  const h = harness({
    timeout: 60,
    challengeTimeout: 60,
    adapter: { probePageError: async () => ++probes >= 2 && probes <= 3 ? { kind: 'challenge' } : null },
    observe: async () => {
      if (++observations === 1) await new Promise(() => {});
      return { text: 'continued answer', route: 'dom' };
    },
  });
  const request = command({ conversationKey: 'recovery-then-deadline' });
  try {
    await assert.rejects(h.complete(request), { code: 'verification' });
    assert.equal(h.pages[0].isClosed(), false);
    assert.equal(h.driver.bindings.entries.get('recovery-then-deadline').pendingChallenge.submitted, true);
    const { result } = await h.complete(request);
    assert.equal(result.text, 'continued answer');
    assert.equal(h.calls.filter(call => call === 'submit').length, 1);
    assert.equal(h.pages.length, 1);
  } finally { await h.driver.close(); }
});

test('cancellation during challenge recovery closes the page instead of persisting it', async () => {
  let entered;
  const recovering = new Promise(resolve => { entered = resolve; });
  const h = harness({
    timeout: 1000,
    challengeTimeout: 500,
    adapter: {
      probePageError: async () => ({ kind: 'challenge' }),
      waitForReady: async (page, { signal }) => {
        entered();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
  });
  const controller = new AbortController();
  const request = h.complete(command({ conversationKey: 'cancel-recovery' }), guard(), controller.signal);
  const rejected = assert.rejects(request, { code: 'upstream' });
  try {
    await recovering;
    controller.abort();
    await rejected;
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.driver.bindings.entries.has('cancel-recovery'), false);
  } finally { await h.driver.close(); }
});

for (const [kind, code] of [['challenge', 'verification'], ['rate-limit', 'cooldown'], ['sign-in', 'expired']]) test(`page ${kind} classification survives deadline during slow teardown`, async () => {
  const h = harness({ timeout: 120, challengeTimeout: 30, adapter: { probePageError: async page => {
    const close = page.close.bind(page);
    page.close = async () => { await delay(200); await close(); };
    return { kind };
  } } });
  try {
    await assert.rejects(h.complete(command({ conversationKey: 'classified' })), { code });
    assert.equal(h.pages[0].isClosed(), kind !== 'challenge');
    assert.equal(h.driver.bindings.entries.size, kind === 'challenge' ? 1 : 0);
    assert.equal(h.calls.includes('submit'), false);
  } finally { await h.driver.close(); }
});

test('cooldown retryAfter survives slow teardown through bridge and translation', async () => {
  const h = harness({ timeout: 120, observe: async page => {
    const close = page.close.bind(page);
    page.close = async () => { await delay(200); await close(); };
    throw new BackendError('cooldown', { retryAfter: 120 });
  } });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); } });
  let server;
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, { handlers: { complete: (request, signal, emit) => h.driver.complete(request, guard(), 'fixture', signal, emit) } });
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  try {
    const source = await bridge.open({ ...command(), method: 'complete' });
    await assert.rejects(async () => {
      for await (const event of translate(source, command())) {}
    }, error => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, 'cooldown');
      assert.equal(error.retryAfter, '120');
      assert.equal(error.toJSON().retryAfter, '120');
      assert.equal(error.headers['retry-after'], '120');
      return true;
    });
  } finally { await bridge.dispose(); await server; await h.driver.close(); }
});

test('unconfirmed temporary chat prevents submission', async () => {
  const h = harness({ adapter: { assertTemporaryChat: async () => ({ ok: false, kind: 'temp-chat-unconfirmed' }) } });
  try {
    await assert.rejects(h.complete(), { code: 'temporary' });
    assert.equal(h.calls.includes('submit'), false);
  } finally { await h.driver.close(); }
});

test('visible/headless conflict is invalidRequest and keeps the active operation intact', async () => {
  const h = harness();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let finish;
  const held = h.driver.browser.run('fixture', async () => { entered(); await new Promise(resolve => { finish = resolve; }); }, undefined, { visibleTurns: false });
  try {
    await ready;
    await assert.rejects(h.complete(command({ visibleTurns: true })), { code: 'invalidRequest' });
    assert.equal(h.context.pages().length, 0);
  } finally { finish(); await held; await h.driver.close(); }
});

test('abort closes the page, clears binding, and permits the next turn', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let attempts = 0;
  const h = harness({ observe: async (page, { signal }) => {
    if (++attempts === 1) {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { text: 'answer', route: 'dom' };
  } });
  const controller = new AbortController();
  const accountGuard = guard();
  try {
    const first = h.complete(command({ conversationKey: 'session' }), accountGuard, controller.signal);
    const rejected = assert.rejects(first);
    await ready;
    controller.abort();
    await rejected;
    assert.equal(h.pages[0].closed, true);
    assert.equal(h.driver.bindings.entries.has('session'), false);
    assert.equal((await h.complete(command({ conversationKey: 'session' }), accountGuard)).result.text, 'answer');
  } finally { await h.driver.close(); }
});

test('bridge abort reaches backend driver cleanup and the next bridge turn succeeds', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let attempts = 0;
  const h = harness({ observe: async (page, { signal }) => {
    if (++attempts === 1) {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { text: 'answer', route: 'dom' };
  } });
  const accountGuard = guard();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.stdin.end(); } });
  let server;
  const bridge = new Bridge({ spawnProcess: () => {
    server = serve(child.stdin, child.stdout, { handlers: { complete: async (request, signal, emit) => { await h.driver.complete(request, accountGuard, 'fixture', signal, emit); } } });
    server.finally(() => child.emit('exit', 0));
    return child;
  } });
  const controller = new AbortController();
  try {
    const first = await bridge.open({ ...command({ conversationKey: 'session' }), method: 'complete' }, controller.signal);
    const rejected = assert.rejects(first.next(), { code: 'upstream' });
    await ready;
    controller.abort();
    await rejected;
    const next = await bridge.open({ ...command({ conversationKey: 'session' }), method: 'complete' });
    const frames = [];
    for await (const frame of next) frames.push(frame);
    assert.equal(h.pages[0].closed, true);
    assert.notEqual(h.driver.bindings.entries.get('session').page, h.pages[0]);
    assert.deepEqual(frames, [{ type: 'delta', index: 0, text: 'answer' }, { type: 'finish', reason: 'complete' }]);
  } finally { await bridge.dispose(); await server; await h.driver.close(); }
});

test('never-completing observation fails truncated within the turn budget', async () => {
  const h = harness({ timeout: 50, observe: async () => new Promise(() => {}) });
  const started = performance.now();
  try {
    await assert.rejects(h.complete(command({ conversationKey: 'stalled' })), { code: 'truncated' });
    assert.ok(performance.now() - started < 1000);
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.driver.bindings.entries.size, 0);
  } finally { await h.driver.close(); }
});

test('overlapping turns serialize while retaining both keyed sessions', async () => {
  let active = 0;
  let maximum = 0;
  const h = harness({ observe: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { text: 'answer', route: 'dom' };
  } });
  const accountGuard = guard();
  try {
    await Promise.all(['one', 'two'].map(conversationKey => h.complete(command({ conversationKey }), accountGuard)));
    assert.equal(maximum, 1);
    for (const entry of h.driver.bindings.entries.values()) {
      assert.equal(entry.busy, false);
      assert.equal(entry.page.isClosed(), false);
      assert.equal(entry.history.at(-1).content, 'answer');
    }
    assert.equal(h.driver.bindings.entries.size, 2);
  } finally { await h.driver.close(); }
});
