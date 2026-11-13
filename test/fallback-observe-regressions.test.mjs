import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTurn } from '../backend/observe.mjs';
import { AccountGuard } from '../backend/guard.mjs';

const frame = (event, data) => ({ kind: 'frame', frame: { event, data: JSON.stringify(data) } });
const message = text => frame('delta', { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [text] }, status: 'in_progress' } } });

test('a challenge painted between the DOM probe and queued 403 does not expire the account', async () => {
  let probes = 0;
  const guard = new AccountGuard();
  await assert.rejects(observeTurn({ isClosed: () => false }, {
    run: { queue: [{ kind: 'status', status: 403 }] }, guard, budget: 1000,
    adapter: { probePageError: async () => ++probes === 1 ? null : { kind: 'challenge' } }, emit: async () => {},
  }), { code: 'verification' });
  assert.equal(probes, 2);
  (await guard.begin())();
});

test('DOM completion cannot end an active SSE stream; final SSE beats rendered text', async () => {
  const run = { queue: [message('**first**')] };
  let reads = 0;
  const events = [];
  const page = { isClosed: () => false, evaluate: async () => {
    reads++;
    return { text: 'first', nodes: 1 };
  } };
  const result = await observeTurn(page, { run, guard: new AccountGuard(), budget: 1500,
    adapter: { probePageError: async () => null, completionState: async () => ({ complete: true }) }, emit: async event => {
      events.push(event);
      if (event.event === 'answer' && event.data.text === '**first**') run.queue.push(frame('delta', { p: '/message/content/parts/0', o: 'append', v: ' and last' }), frame('', '[DONE]'));
    } });
  assert.equal(reads, 2);
  assert.equal(result.text, '**first** and last');
  assert.equal(result.route, 'sse');
  assert.equal(events.filter(event => event.event === '').length, 1);
});

test('non-prefix SSE replacements remain canonical instead of degrading to DOM', async () => {
  const run = { queue: [message('[TOOL]{"old":')] };
  const events = [];
  const revised = '[TOOL]{"name":"run","input":{}}[/TOOL]';
  const page = { isClosed: () => false, evaluate: async () => ({ text: '[TOOL]', nodes: 1 }) };
  const result = await observeTurn(page, { run, guard: new AccountGuard(), budget: 1500,
    adapter: { probePageError: async () => null, completionState: async () => ({ complete: false }) }, emit: async event => {
      events.push(event);
      if (event.event === 'answer') run.queue.push(frame('delta', { p: '/message/content/parts/0', o: 'replace', v: revised }), frame('', '[DONE]'));
    } });
  assert.equal(result.text, revised);
  assert.ok(events.some(event => event.event === 'dom' && event.data.source === 'sse' && event.data.text === revised));
  assert.equal(events.some(event => event.data?.kind === 'observationFailure'), false);
});

test('network capture enabled still permits a completed DOM-only answer', async () => {
  const result = await observeTurn({ isClosed: () => false, evaluate: async () => ({ text: 'DOM only', nodes: 1 }) }, {
    run: { queue: [], networkExpected: true }, guard: new AccountGuard(), budget: 100,
    adapter: { probePageError: async () => null, completionState: async () => ({ complete: true }) }, emit: async () => {},
  });
  assert.deepEqual(result, { text: 'DOM only', route: 'dom' });
});

test('SSE queued during DOM reads is reconciled before accepting DOM completion', async () => {
  const run = { queue: [], networkExpected: true };
  let reads = 0;
  const events = [];
  const page = { isClosed: () => false, evaluate: async () => {
    if (++reads === 1) run.queue.push(message('**canonical**'), frame('', '[DONE]'));
    return { text: 'rendered', nodes: 1 };
  } };
  const result = await observeTurn(page, { run, guard: new AccountGuard(), budget: 100,
    adapter: { probePageError: async () => null, completionState: async () => ({ complete: true }) }, emit: async event => events.push(event) });
  assert.equal(result.text, '**canonical**');
  assert.equal(events.some(event => event.data?.text === 'rendered'), false);
});
