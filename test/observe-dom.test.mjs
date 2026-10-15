import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { installHarvest } from '../backend/harvest.mjs';
import { observeTurn } from '../backend/observe.mjs';
import { AccountGuard } from '../backend/guard.mjs';

const adapter = {
  async probePageError() { return null; },
  async completionState(page) {
    return page.evaluate(() => {
      const current = document.querySelector('[data-content-search-unit-key$=":assistant"]');
      const node = current ?? document.querySelector('[data-message-author-role="assistant"], [aria-label="Assistant response"]');
      const layout = current ? 'current' : node ? 'legacy' : 'current';
      return { complete: !!node && node.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') === 'complete', layout, signal: 'turn-state' };
    });
  },
};
const sse = (event, data) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const terminator = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const visibleMessage = text => ({ o: 'add', p: '', v: { message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [text] }, status: 'in_progress' } } });
const current = (text, state = 'complete') => `<article data-talvt-turn-state="${state}"><section data-content-search-unit-key="turn:assistant"><span data-conversation-role="assistant"></span><div>${text}</div></section></article>`;

async function fixture(t, { html = '<main></main>', conversation } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/backend-api/conversation') return conversation(req, res);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>${html}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  const run = { id: 'fixture', queue: [] };
  let resolveEof;
  const eof = new Promise(resolve => { resolveEof = resolve; });
  await page.exposeFunction('__chatgptHarvestEvent', item => { run.queue.push(item); if (item.kind === 'eof') resolveEof(); });
  await page.evaluate(installHarvest);
  await page.evaluate(() => window.__chatgptHarvest.start('fixture'));
  if (html !== '<main></main>') await page.evaluate(markup => { document.body.innerHTML = markup; }, html);
  const events = [];
  return { page, run, events, eof, options: { run, adapter, guard: new AccountGuard(), budget: 5000, signal: new AbortController().signal, emit: event => events.push(event) } };
}
const logs = events => events.filter(event => event.event === 'log').map(event => event.data);

test('snapshot honors the adapter-selected layout even with both layouts present', async t => {
  const { page } = await fixture(t, { html: `${current('CURRENT')}<p data-message-author-role="assistant">LEGACY</p>` });
  const snapshot = await page.evaluate(() => window.__chatgptHarvest.snapshot('legacy'));
  assert.equal(snapshot.text, 'LEGACY');
  assert.equal(snapshot.layout, 'legacy');
});

test('whitespace trailing an SSE block remains a partial eof', async t => {
  const { page, run, eof } = await fixture(t, { conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n ');
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await eof;
  assert.equal(run.queue.find(item => item.kind === 'eof')?.partial, true);
});

test('DOM primary completes from turn-state without any copy button and streams intermediate polls', async t => {
  const { page, options, events } = await fixture(t, { html: current('First half', 'in-progress') });
  setTimeout(() => { page.evaluate(() => { document.querySelector('article section div').innerText = 'First half and second half'; document.querySelector('article').dataset.talvtTurnState = 'complete'; }).catch(() => {}); }, 700);
  assert.deepEqual(await observeTurn(page, options), { text: 'First half and second half', route: 'dom' });
  const deltas = events.filter(event => event.event === 'dom').map(event => event.data.text);
  assert.ok(deltas.includes('First half'), `expected an intermediate poll delta, got ${JSON.stringify(deltas)}`);
  assert.equal(events.at(-1).event, '');
});

test('message_stream_complete terminator completes the SSE route without a copy button', async t => {
  const { page, options, run } = await fixture(t, { conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('delta', visibleMessage('SSE answer')));
    res.write(terminator({ type: 'message_stream_complete' }));
    res.end();
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  assert.deepEqual(await observeTurn(page, options), { text: 'SSE answer', route: 'sse' });
  assert.equal(run.queue.length, 0);
});

test('finished_successfully status patch completes the stream', async t => {
  const { page, options } = await fixture(t, { conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('delta', visibleMessage('Patched answer')));
    res.write(sse('delta', { o: 'replace', p: '/message/status', v: 'finished_successfully' }));
    res.end();
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  assert.deepEqual(await observeTurn(page, options), { text: 'Patched answer', route: 'sse' });
});

test('eof with a trailing partial buffer is truncated, never a fabricated completion', async t => {
  const { page, options, events } = await fixture(t, { conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('delta', visibleMessage('Partial answer')));
    res.write('data: {"trailing"');
    res.end();
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await assert.rejects(observeTurn(page, options), error => error.code === 'truncated');
  assert.equal(events.filter(event => event.event === '').length, 0);
});

test('clone-unavailable degrades to the DOM route with an explicit log record', async t => {
  const { page, options, events } = await fixture(t, { html: current('DOM answer', 'in-progress'), conversation: (req, res) => { res.writeHead(204); res.end(); } });
  await page.evaluate(() => { Response.prototype.clone = () => { throw new Error('clone unavailable'); }; });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  setTimeout(() => { page.evaluate(() => { document.querySelector('article').dataset.talvtTurnState = 'complete'; }).catch(() => {}); }, 700);
  assert.deepEqual(await observeTurn(page, options), { text: 'DOM answer', route: 'dom', degraded: 'clone-unavailable' });
  assert.ok(logs(events).some(record => record.kind === 'observationDegraded' && record.degraded === 'clone-unavailable'));
});

test('a dual-layout page reads exactly one layout and logs which', async t => {
  const html = `${current('CURRENT')}<article data-talvt-turn-state="complete"><p data-message-author-role="assistant">LEGACY</p></article>`;
  const { page, options, events } = await fixture(t, { html });
  assert.deepEqual(await observeTurn(page, options), { text: 'CURRENT', route: 'dom' });
  assert.ok(logs(events).some(record => record.kind === 'observationLayout' && record.layout === 'current'));
  const legacyHtml = '<article data-talvt-turn-state="complete"><p data-message-author-role="assistant">LEGACY</p></article>';
  const legacy = await fixture(t, { html: legacyHtml });
  assert.deepEqual(await observeTurn(legacy.page, legacy.options), { text: 'LEGACY', route: 'dom' });
  assert.ok(logs(legacy.events).some(record => record.kind === 'observationLayout' && record.layout === 'legacy'));
});

test('copy button alone cannot complete an observation', async t => {
  const { page, options } = await fixture(t, { html: '<article><p data-message-author-role="assistant">Pending</p><button aria-label="Copy">Copy</button></article>' });
  options.budget = 50;
  await assert.rejects(observeTurn(page, options), error => error.code === 'truncated');
});

test('a partial eof rejects even when the DOM already reports completion', async t => {
  const { page, options, run } = await fixture(t, { html: current('Answer') });
  run.queue.push({ kind: 'eof', partial: true });
  await assert.rejects(observeTurn(page, options), error => error.code === 'truncated');
});

test('abort stops observation without emitting completion', async t => {
  const { page, options, events } = await fixture(t);
  const controller = new AbortController();
  options.signal = controller.signal;
  controller.abort();
  await assert.rejects(observeTurn(page, options), error => error.name === 'AbortError');
  assert.equal(events.length, 0);
});

test('challenge evidence outranks everything and maps to verification', async t => {
  const { page, options } = await fixture(t, { html: current('An answer') });
  options.adapter = { ...adapter, async probePageError() { return { kind: 'challenge', evidence: 'iframe' }; } };
  await assert.rejects(observeTurn(page, options), error => error.code === 'verification');
});

test('a rate-limit probe maps to cooldown with a retry-after', async t => {
  const { page, options } = await fixture(t, { html: current('An answer') });
  options.adapter = { ...adapter, async probePageError() { return { kind: 'rate-limit', evidence: 'dialog' }; } };
  await assert.rejects(observeTurn(page, options), error => error.code === 'cooldown' && typeof error.retryAfter === 'string');
});

test('a non-ok conversation status maps through the response failure', async t => {
  const { page, options } = await fixture(t, { conversation: (req, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end(); } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await assert.rejects(observeTurn(page, options), error => error.code === 'cooldown' && error.retryAfter === '30');
});
