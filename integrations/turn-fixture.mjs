import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function createTurnFixture({ interval = 450, stall = 0 } = {}) {
  const requests = [];
  let mode = 'normal';
  const batches = ['A floating garden rises above the water. ', 'Its silver leaves collect the morning rain. ', 'A narrow path leads back to the quiet shore.'];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/backend-api/f/conversation') {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await delay(stall);
      if (mode === 'changed') { frame('changed_encoding', {}); response.end(); return; }
      frame('delta_encoding', 'v1');
      frame('delta', { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: mode === 'hidden' }, status: 'in_progress' } } });
      if (!['empty', 'hidden'].includes(mode)) for (const [index, batch] of batches.entries()) {
        await delay(interval);
        if (response.destroyed) return;
        if (mode === 'user-add' && index === 1) frame('delta', { p: '', o: 'add', v: { message: { author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['a mid-answer user note'] }, status: 'finished_successfully' } } });
        frame('delta', { ...((index === 0 || (mode === 'user-add' && index === 1)) ? { o: 'patch' } : {}), v: [{ p: '/message/content/parts/0', o: 'append', v: batch }, { p: '/message/metadata/model_dil_v2/constants', o: 'append', v: 'metadata must not appear' }] });
        if (mode === 'truncated') { response.end(); return; }
      }
      frame('delta', { o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] });
      frame('', { type: 'message_stream_complete' });
      response.end('data: [DONE]\n\n');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><title>Local chat fixture</title></head><body>
      <button aria-label="Open profile menu">Fixture account</button><p>Temporary chat</p>
      <main id="messages"></main><textarea aria-label="Message"></textarea>
      <script>
      const mode = ${JSON.stringify(mode)};
      const input = document.querySelector('textarea');
      let conversation = location.pathname.startsWith('/c/') ? location.pathname.slice(3) : crypto.randomUUID();
      if (mode === 'clone-failure') Response.prototype.clone = function () { throw new Error('fixture refuses clone'); };
      input.addEventListener('keydown', async event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (mode === 'rate' || mode === 'challenge') {
          const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
          dialog.textContent = mode === 'rate' ? 'You have reached the usage limit' : 'Verify you are human';
          document.body.append(dialog); return;
        }
        const article = document.createElement('article');
        const answer = document.createElement('div'); answer.setAttribute('aria-label', 'Assistant response');
        article.append(answer); document.querySelector('main').append(article);
        const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop generating'); document.body.append(stop);
        history.replaceState(null, '', '/c/' + conversation);
        const response = await fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ conversation, prompt: input.value }) });
        input.value = '';
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); let end;
          while ((end = buffer.indexOf('\\n\\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\\n').find(line => line.startsWith('data: '))?.slice(6);
            if (!data || data === '[DONE]') continue;
            const item = JSON.parse(data);
            if (Array.isArray(item.v)) for (const operation of item.v) {
              if (operation.p === '/message/content/parts/0') answer.textContent += operation.v;
              if (operation.p === '/message/status') completed = true;
            }
          }
        }
        stop.remove();
        if (completed) { const copy = document.createElement('button'); copy.setAttribute('aria-label', 'Copy'); article.append(copy); }
      });
      </script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`, requests, batches,
    setMode(value) { mode = value; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
