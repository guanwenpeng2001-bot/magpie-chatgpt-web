import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
const browserTest = (name, body) => test(name, async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts, then node --test test/observe-dom.test.mjs (requires Chrome).');
    return;
  }
  await body(t);
});
const current = (text, state = 'complete') => `<article data-talvt-turn-state="${state}"><section data-content-search-unit-key="turn:assistant"><span data-conversation-role="assistant"></span><div>${text}</div></section></article>`;

async function fixture(t, { html = '<main></main>', conversation } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/backend-api/conversation') return conversation(req, res);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>${html}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { chromium } = await import('playwright-core');
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

browserTest('snapshot honors the adapter-selected layout even with both layouts present', async t => {
  const { page } = await fixture(t, { html: `${current('CURRENT')}<p data-message-author-role="assistant">LEGACY</p>` });
  const snapshot = await page.evaluate(() => window.__chatgptHarvest.snapshot('legacy'));
  assert.equal(snapshot.text, 'LEGACY');
  assert.equal(snapshot.layout, 'legacy');
});

browserTest('whitespace trailing an SSE block remains a partial eof', async t => {
  const { page, run, eof } = await fixture(t, { conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n ');
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await eof;
  assert.equal(run.queue.find(item => item.kind === 'eof')?.partial, true);
});

browserTest('DOM primary completes from turn-state without any copy button and streams intermediate polls', async t => {
  const { page, options, events } = await fixture(t, { html: current('First half', 'in-progress') });
  setTimeout(() => { page.evaluate(() => { document.querySelector('article section div').innerText = 'First half and second half'; document.querySelector('article').dataset.talvtTurnState = 'complete'; }).catch(() => {}); }, 700);
  assert.deepEqual(await observeTurn(page, options), { text: 'First half and second half', route: 'dom' });
  const deltas = events.filter(event => event.event === 'dom').map(event => event.data.text);
  assert.ok(deltas.includes('First half'), `expected an intermediate poll delta, got ${JSON.stringify(deltas)}`);
  assert.equal(events.at(-1).event, '');
});

browserTest('message_stream_complete terminator completes the SSE route without a copy button', async t => {
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

browserTest('finished_successfully status patch completes the stream', async t => {
  const { page, options } = await fixture(t, { conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('delta', visibleMessage('Patched answer')));
    res.write(sse('delta', { o: 'replace', p: '/message/status', v: 'finished_successfully' }));
    res.end();
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  assert.deepEqual(await observeTurn(page, options), { text: 'Patched answer', route: 'sse' });
});

browserTest('eof with a trailing partial buffer is truncated, never a fabricated completion', async t => {
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

browserTest('clone-unavailable degrades to the DOM route with an explicit log record', async t => {
  const { page, options, events } = await fixture(t, { html: current('DOM answer', 'in-progress'), conversation: (req, res) => { res.writeHead(204); res.end(); } });
  await page.evaluate(() => { Response.prototype.clone = () => { throw new Error('clone unavailable'); }; });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  setTimeout(() => { page.evaluate(() => { document.querySelector('article').dataset.talvtTurnState = 'complete'; }).catch(() => {}); }, 700);
  assert.deepEqual(await observeTurn(page, options), { text: 'DOM answer', route: 'dom', degraded: 'clone-unavailable' });
  assert.ok(logs(events).some(record => record.kind === 'observationDegraded' && record.degraded === 'clone-unavailable'));
});

browserTest('a dual-layout page reads exactly one layout and logs which', async t => {
  const html = `${current('CURRENT')}<article data-talvt-turn-state="complete"><p data-message-author-role="assistant">LEGACY</p></article>`;
  const { page, options, events } = await fixture(t, { html });
  assert.deepEqual(await observeTurn(page, options), { text: 'CURRENT', route: 'dom' });
  assert.ok(logs(events).some(record => record.kind === 'observationLayout' && record.layout === 'current'));
  const legacyHtml = '<article data-talvt-turn-state="complete"><p data-message-author-role="assistant">LEGACY</p></article>';
  const legacy = await fixture(t, { html: legacyHtml });
  assert.deepEqual(await observeTurn(legacy.page, legacy.options), { text: 'LEGACY', route: 'dom' });
  assert.ok(logs(legacy.events).some(record => record.kind === 'observationLayout' && record.layout === 'legacy'));
});

browserTest('copy button alone cannot complete an observation', async t => {
  const { page, options } = await fixture(t, { html: '<article><p data-message-author-role="assistant">Pending</p><button aria-label="Copy">Copy</button></article>' });
  options.budget = 50;
  await assert.rejects(observeTurn(page, options), error => error.code === 'truncated');
});

browserTest('whitespace-tail eof yields to a DOM-confirmed answer', async t => {
  const { page, options, eof, run } = await fixture(t, { html: current('Answer'), conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse('delta', visibleMessage('Answer')) + terminator('[DONE]') + '\n');
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await eof;
  assert.equal(run.queue.find(item => item.kind === 'eof').partial, true);
  assert.deepEqual(await observeTurn(page, options), { text: 'Answer', route: 'dom' });
});

for (const ordering of ['SSE first', 'DOM first']) {
  browserTest(`rendered DOM supersedes markdown in both carriers: ${ordering}`, async t => {
    const { page, options, events, eof } = await fixture(t, { html: current('Here is <b>bold</b> text', 'in-progress'), conversation: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse('delta', visibleMessage('Here is **bold** text')) + terminator('[DONE]'));
    } });
    const finish = async () => {
      await page.evaluate(() => fetch('/backend-api/conversation'));
      await eof;
      await page.evaluate(() => { document.querySelector('article').dataset.talvtTurnState = 'complete'; });
    };
    if (ordering === 'SSE first') await finish();
    else options.emit = async event => {
      events.push(event);
      if (event.event === 'dom' && events.filter(item => item.event === 'dom').length === 1) await finish();
    };
    assert.deepEqual(await observeTurn(page, options), { text: 'Here is bold text', route: 'dom' });
    assert.equal(events.filter(event => event.event === 'dom').at(-1).data.text, 'Here is bold text');
    assert.equal(events.at(-1).event, '');
  });
}

for (const answer of ['partial', 'absent', 'delayed']) {
  browserTest(`post-handoff DONE requires DOM confirmation: ${answer}`, async t => {
    const { page, options, events, eof } = await fixture(t, { html: answer === 'partial' ? current('First third', 'in-progress') : '<main></main>', conversation: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(terminator({ type: 'stream_handoff' }) + terminator('[DONE]'));
    } });
    await page.evaluate(() => fetch('/backend-api/conversation'));
    await eof;
    if (answer === 'delayed') {
      await page.evaluate(markup => { setTimeout(() => { document.body.innerHTML = markup; }, 1200); }, current('Delayed answer'));
      assert.deepEqual(await observeTurn(page, options), { text: 'Delayed answer', route: 'dom' });
      assert.equal(events.at(-1).event, '');
    } else {
      options.budget = 650;
      await assert.rejects(observeTurn(page, options), error => error.code === 'truncated');
      assert.equal(events.filter(event => event.event === '').length, 0);
    }
  });
}

for (const complete of [true, false]) {
  browserTest(`binding rejection degrades and waits for DOM confirmation: ${complete}`, async t => {
    const { page, options, events } = await fixture(t, { html: current('Rendered answer', complete ? 'complete' : 'in-progress'), conversation: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(terminator('[DONE]'));
    } });
    await page.evaluate(async () => {
      window.__chatgptHarvestEvent = async () => { throw new Error('fixture binding rejection'); };
      await fetch('/backend-api/conversation');
    });
    await page.waitForFunction(() => window.__chatgptHarvest.snapshot().failed);
    options.budget = 650;
    if (complete) assert.deepEqual(await observeTurn(page, options), { text: 'Rendered answer', route: 'dom' });
    else {
      await assert.rejects(observeTurn(page, options), error => error.code === 'harvest' && error.cause === 'Error: fixture binding rejection');
      assert.equal(events.filter(event => event.event === '').length, 0);
    }
    assert.equal(logs(events).filter(record => record.kind === 'observationFailure' && record.code === 'harvest' && record.cause === 'Error: fixture binding rejection').length, 1);
  });
}

for (const shape of ['matching DOM with lagging turn-state', 'empty complete DOM', 'legacy DOM without status']) {
  browserTest(`healthy stream completes with ${shape}`, async t => {
    const html = shape === 'legacy DOM without status' ? '<p data-message-author-role="assistant">Plain answer</p>'
      : shape === 'empty complete DOM' ? current('') : current('Plain answer', 'in-progress');
    const { page, options, events, eof } = await fixture(t, { html, conversation: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse('delta', visibleMessage('Plain answer')) + terminator({ type: 'message_stream_complete' }));
    } });
    await page.evaluate(() => fetch('/backend-api/conversation'));
    await eof;
    options.budget = 650;
    assert.deepEqual(await observeTurn(page, options), { text: 'Plain answer', route: shape === 'empty complete DOM' ? 'sse' : 'dom' });
    assert.equal(events.some(event => event.event === 'dom' && !event.data.text), false);
    assert.equal(events.filter(event => event.event === '').length, 1);
  });
}

browserTest('complete stream waits for a rendered prefix to become the full answer', async t => {
  const fullText = 'First half and second half';
  const { page, options, events, eof } = await fixture(t, { html: current('First half', 'in-progress'), conversation: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse('delta', visibleMessage(fullText)) + terminator({ type: 'message_stream_complete' }));
  } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await eof;
  options.emit = async event => {
    events.push(event);
    if (event.event === 'dom' && event.data.text === 'First half') {
      await page.evaluate(text => {
        document.querySelector('article section div').innerText = text;
        document.querySelector('article').dataset.talvtTurnState = 'complete';
      }, fullText);
    }
  };
  assert.deepEqual(await observeTurn(page, options), { text: fullText, route: 'dom' });
  assert.deepEqual(events.filter(event => event.event === 'dom').map(event => event.data.text), ['First half', fullText]);
  assert.equal(events.filter(event => event.event === '').length, 1);
  assert.equal(events.at(-1).event, '');
});

browserTest('abort stops observation without emitting completion', async t => {
  const { page, options, events } = await fixture(t);
  const controller = new AbortController();
  options.signal = controller.signal;
  controller.abort();
  await assert.rejects(observeTurn(page, options), error => error.name === 'AbortError');
  assert.equal(events.length, 0);
});

browserTest('challenge evidence outranks everything and maps to verification', async t => {
  const { page, options } = await fixture(t, { html: current('An answer') });
  options.adapter = { ...adapter, async probePageError() { return { kind: 'challenge', evidence: 'iframe' }; } };
  await assert.rejects(observeTurn(page, options), error => error.code === 'verification');
});

browserTest('a rate-limit probe maps to cooldown with a retry-after', async t => {
  const { page, options } = await fixture(t, { html: current('An answer') });
  options.adapter = { ...adapter, async probePageError() { return { kind: 'rate-limit', evidence: 'dialog' }; } };
  await assert.rejects(observeTurn(page, options), error => error.code === 'cooldown' && typeof error.retryAfter === 'string');
});

browserTest('a non-ok conversation status maps through the response failure', async t => {
  const { page, options } = await fixture(t, { conversation: (req, res) => { res.writeHead(429, { 'retry-after': '30' }); res.end(); } });
  await page.evaluate(() => fetch('/backend-api/conversation'));
  await assert.rejects(observeTurn(page, options), error => error.code === 'cooldown' && error.retryAfter === '30');
});
