import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard, BackendError } from '../backend/guard.mjs';
import { prepare } from '../src/wire/prepare.mjs';
import { usageProfile } from '../src/usage/store.mjs';

const command = extra => ({ auth: { profile: 'offline-usage', refresh: 'next-auth.session-token=fixture' },
  model: 'gpt-6', history: [{ role: 'user', content: 'Inspect the fixture.' }], ...extra });

// Exercise complete(), Conversations and BrowserSupervisor; only the page,
// browser adapter/observer and optional persistence boundary are substituted.
function harness(t, options = {}) {
  const calls = [], pages = [], receipts = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages,
    cookies: async () => [{ name: 'next-auth.session-token', value: 'fixture' }],
    exposeBinding: async () => {}, addInitScript: async () => {},
    async newCDPSession() {
      return { async send(method) { return method === 'Browser.getWindowForTarget'
        ? { windowId: 1, bounds: { left: 80, top: 80, width: 1280, height: 900 } } : {}; }, async detach() {} };
    },
    async newPage() {
      const page = {
        closed: false, isClosed() { return this.closed; },
        async close() { this.closed = true; }, async bringToFront() {}, async goto() {},
        async evaluate() {},
        locator() { return { filter() { return this; }, async fill() { calls.push('fill'); },
          async press() { calls.push('submit'); }, async evaluateAll() { return []; } }; },
      };
      pages.push(page); return page;
    },
    async close() { for (const page of pages) await page.close(); this.emit('close'); },
  });
  const adapter = {
    async assertTemporaryChat() { return true; }, async probePageError() { return null; },
    async readComposer() { return { ok: true }; }, async selectModel() { return { ok: true }; },
    async submitPrompt() { calls.push('submit'); return { ok: true }; }, async waitForReady() {},
    async initializeWorkPage() {}, async initializeImagePage() {}, async stopWork() {},
    async readGeneratedImages() { return { text: 'Generated offline image' }; }, ...options.adapter,
  };
  const driver = new TurnDriver({ profileRoot: '/offline-fixture', launch: async () => context,
    observe: async () => ({ text: 'Answer', route: 'dom' }),
    prepareReceipt: async input => {
      calls.push('prepare');
      const receipt = { input, confirmations: 0, gaps: 0, flushes: 0 };
      receipts.push(receipt);
      // Intentionally NOT idempotent: the driver must not duplicate callbacks.
      return { confirm() { receipt.confirmations++; }, uncertain() { receipt.gaps++; }, flush() { receipt.flushes++; } };
    }, ...options, adapter });
  const complete = (input = command(), signal = new AbortController().signal, emit = () => {}) =>
    driver.complete(input, new AccountGuard({ sleep: async () => {} }), 'offline-owner', signal, emit);
  t.after(() => driver.close());
  return { driver, calls, pages, receipts, complete };
}

test('one physical Send confirms once before client delivery and uses the selected Chat model/account home', async t => {
  const h = harness(t, { observe: async (_page, { run, emit }) => {
    assert.equal(h.receipts[0].input.id, run.id);
    assert.equal(h.receipts[0].confirmations, 0, 'click alone is not acceptance');
    await emit({ event: 'log', data: { text: 'not generated output' } });
    await emit({ event: 'answer', data: { text: '' } });
    assert.equal(h.receipts[0].confirmations, 0);
    await emit({ event: 'dom', data: { text: 'Answer' } });
    await emit({ event: 'dom', data: { text: 'Answer' } });
    return { text: 'Answer' };
  } });
  await h.complete(command({ selectionModel: 'gpt-6-pro' }), undefined, frame => {
    if (frame.type === 'delta') assert.equal(h.receipts[0].confirmations, 1);
  });
  assert.deepEqual(h.calls, ['fill', 'prepare', 'submit']);
  const { input, confirmations, gaps, flushes } = h.receipts[0];
  assert.equal(input.profile, usageProfile('offline-usage'));
  assert.equal(input.page, h.pages[0]);
  assert.deepEqual({ model: input.model, effort: input.effort, source: input.source, stage: input.stage },
    { model: 'gpt-6-pro', effort: 'max', source: 'text', stage: 'message' });
  assert.deepEqual({ confirmations, gaps, flushes }, { confirmations: 1, gaps: 0, flushes: 1 });
});

test('a final-only nonempty response confirms acceptance', async t => {
  const h = harness(t);
  await h.complete();
  assert.equal(h.receipts[0].confirmations, 1);
});

test('duplicate observations across repeated post-send challenge recoveries reuse the receipt and run id', async t => {
  let attempts = 0, challenged = false;
  const runIds = [];
  const h = harness(t, {
    adapter: { probePageError: async () => challenged ? { kind: 'challenge' } : null,
      waitForReady: async () => { challenged = false; } },
    observe: async (_page, { run, emit }) => {
      runIds.push(run.id);
      await emit({ event: 'dom', data: { text: 'Answer' } });
      if (++attempts < 3) { challenged = true; throw new BackendError('verification'); }
      return { text: 'Answer' };
    },
  });
  await h.complete(command({ conversationKey: 'challenge-loop' }));
  assert.equal(new Set(runIds).size, 1);
  assert.equal(h.calls.filter(call => call === 'submit').length, 1);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0].confirmations, 1);
  assert.equal(h.receipts[0].gaps, 0);
});

test('a preserved challenge resumes in a new complete call without preparing or sending again', async t => {
  let challenged = false, resume = false;
  const runIds = [];
  const h = harness(t, {
    adapter: { probePageError: async () => challenged ? { kind: 'challenge' } : null,
      waitForReady: async () => {
        if (challenged && !resume) throw new BackendError('verification');
        challenged = false;
      } },
    observe: async (_page, { run }) => {
      runIds.push(run.id);
      if (!resume) { challenged = true; throw new BackendError('verification'); }
      return { text: 'Recovered answer' };
    },
  });
  const input = command({ conversationKey: 'preserved-challenge' });
  await assert.rejects(h.complete(input), { code: 'verification' });
  assert.equal(h.receipts[0].confirmations, 0);
  assert.equal(h.receipts[0].gaps, 1, 'submitted without acceptance remains uncertain');
  resume = true;
  await h.complete(input);
  assert.equal(new Set(runIds).size, 1);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.calls.filter(call => call === 'submit').length, 1);
  assert.equal(h.receipts[0].confirmations, 1);
  assert.equal(h.receipts[0].gaps, 1);
});

const toolRequest = () => command(prepare({ model: 'gpt-6', conversation_id: 'offline-tools',
  messages: [{ role: 'user', content: 'Inspect the fixture.' }],
  tools: [{ name: 'exec_command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
}));

test('a tool-result continuation counts its new physical Send, not each tool call', async t => {
  const input = toolRequest();
  let attempts = 0;
  const h = harness(t, { observe: async () => ({ text: ++attempts === 1
    ? `${input.start}{"name":"exec_command","input":{"cmd":"offline"}}${input.end}` : 'Done' }) });
  await h.complete(input);
  const binding = h.driver.bindings.entries.get(input.conversationKey);
  const assistant = binding.history.at(-1);
  assert.match(assistant.content, /^\[Previous tool call\]\n/);
  const tool = JSON.parse(assistant.content.slice('[Previous tool call]\n'.length));
  await h.complete(command(prepare({ model: input.model, conversation_id: input.conversationKey, tools: input.tools,
    messages: [{ role: 'user', content: 'Inspect the fixture.' },
      { role: 'assistant', content: [{ type: 'tool_use', ...tool }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'Offline result' }] }] })));
  assert.equal(h.pages.length, 1);
  assert.equal(h.calls.filter(call => call === 'submit').length, 2);
  assert.equal(new Set(h.receipts.map(receipt => receipt.input.id)).size, 2);
  assert.deepEqual(h.receipts.map(receipt => receipt.confirmations), [1, 1]);
});

test('repair Sends have distinct receipts, including an unobserved failed repair', async t => {
  const input = toolRequest();
  let attempts = 0;
  const h = harness(t, { observe: async (_page, { emit }) => {
    if (++attempts === 1) {
      await emit({ event: 'dom', data: { text: input.start } });
      return { text: input.start };
    }
    if (attempts === 2) throw new BackendError('truncated');
    await emit({ event: 'answer', data: { text: '{"name":"exec_command","input":{"cmd":"offline"}}' } });
    return { text: '{"name":"exec_command","input":{"cmd":"offline"}}' };
  } });
  assert.equal((await h.complete(input)).repaired, true);
  assert.equal(h.calls.filter(call => call === 'submit').length, 3);
  assert.equal(new Set(h.receipts.map(receipt => receipt.input.id)).size, 3);
  assert.deepEqual(h.receipts.map(receipt => [receipt.confirmations, receipt.gaps]), [[1, 0], [0, 1], [1, 0]]);
});

test('no accepted output records only a gap after a confirmed click, including misleading challenge text', async t => {
  const h = harness(t, { observe: async (_page, { emit }) => {
    await emit({ event: 'dom', data: { text: 'cloudflare_challenge' } });
    throw new BackendError('truncated');
  } });
  await assert.rejects(h.complete(), { code: 'truncated' });
  assert.deepEqual(h.receipts.map(receipt => [receipt.confirmations, receipt.gaps]), [[0, 1]]);
  assert.equal(h.calls.filter(call => call === 'submit').length, 1);
});

test('cancellation after receipt preparation but before Send does not create a gap', async t => {
  const abort = new AbortController();
  let confirmations = 0, gaps = 0;
  const h = harness(t, { prepareReceipt: async () => {
    abort.abort(new Error('Offline cancellation'));
    return { confirm() { confirmations++; }, uncertain() { gaps++; }, flush() {} };
  } });
  await assert.rejects(h.complete(command(), abort.signal), { code: 'upstream' });
  assert.equal(h.calls.includes('submit'), false);
  assert.deepEqual({ confirmations, gaps }, { confirmations: 0, gaps: 0 });
});

for (const failure of ['prepare', 'confirm', 'flush']) test(`accounting ${failure} failure cannot fail or retry a completed model response`, async t => {
  const h = harness(t, { prepareReceipt: async () => {
    if (failure === 'prepare') throw new Error('Offline accounting failure');
    return { confirm() { if (failure === 'confirm') return Promise.reject(new Error('Offline accounting failure')); },
      flush() { if (failure === 'flush') throw new Error('Offline accounting failure'); } };
  } });
  assert.equal((await h.complete()).text, 'Answer');
  assert.equal(h.calls.filter(call => call === 'submit').length, 1);
});

test('uncertain/flush failures preserve the original observation failure', async t => {
  const h = harness(t, { observe: async () => { throw new BackendError('truncated'); },
    prepareReceipt: async () => ({ uncertain() { throw new Error('Offline accounting failure'); },
      flush: async () => { throw new Error('Offline flush failure'); } }) });
  await assert.rejects(h.complete(), { code: 'truncated' });
  assert.equal(h.calls.filter(call => call === 'submit').length, 1);
});

test('accepted output stays counted when subsequent observation fails', async t => {
  const h = harness(t, { observe: async (_page, { emit }) => {
    await emit({ event: 'answer', data: { text: 'Partial answer' } });
    throw new BackendError('truncated');
  } });
  await assert.rejects(h.complete(), { code: 'truncated' });
  assert.deepEqual(h.receipts.map(receipt => [receipt.confirmations, receipt.gaps]), [[1, 0]]);
});

for (const model of ['gpt-6-sol-wm', 'chatgpt-image']) test(`${model} does not prepare or count Chat receipts`, async t => {
  const h = harness(t);
  await h.complete(command({ model }));
  assert.equal(h.calls.filter(call => call === 'submit').length, 1);
  assert.equal(h.receipts.length, 0);
});
