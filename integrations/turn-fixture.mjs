import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Frames 2–7 reconstruct routing fields from truncated capture heads; frame 8 is complete.
export const handoffFrames = [
  { event: 'delta_encoding', data: 'v1' },
  { event: '', data: { type: 'resume_conversation_token', kind: 'topic', token: 'offline-synthetic-token' } },
  { event: 'delta', data: { p: '', o: 'add', v: { message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['[Human]\nReply with exactly: pong'] }, status: 'finished_successfully' } } } },
  { event: 'delta', data: { v: { message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, status: 'finished_successfully', metadata: { rebase_system_message: true, is_visually_hidden_from_conversation: true, resolved_model_slug: 'gpt-6-pro' } } } } },
  { event: 'delta', data: { v: { message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, status: 'finished_successfully', metadata: { rebase_developer_message: true, is_visually_hidden_from_conversation: true, resolved_model_slug: 'gpt-6-pro' } } } } },
  { event: 'delta', data: { v: { message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, status: 'finished_successfully', metadata: { exclusive_key: 'plugin_upsell', rebase_developer_message: false } } } } },
  { event: 'delta', data: { v: { message: { author: { role: 'tool', name: 'a8km123' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress' } } } },
  { event: '', data: { type: 'stream_handoff', conversation_id: '6acd141c-6b40-83e9-a915-fbdf180e0a3d', turn_exchange_id: '24373ad2-694f-4cfe-bebb-d25be8bcef56', options: [{ type: 'resume_sse_endpoint', topic_id: 'conversation-turn-24373ad2-694f-4cfe-bebb-d25be8bcef56' }, { type: 'subscribe_ws_topic', topic_id: 'conversation-turn-24373ad2-694f-4cfe-bebb-d25be8bcef56' }] } },
];

export function siteAdapterHtml({ picker = 'single', rows = [{ slug: 'gpt-6', title: 'GPT-6' }], composer = 'textarea', temporary = true, challenge, rate, signIn = false, images = false, rejectImage = false, layout, complete = false } = {}) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const trigger = '<button data-codex-intelligence-trigger="true" aria-haspopup="menu" data-composer-navigation-target="reasoning">Choose model</button>';
  const entries = rows.map(row => `<div role="menuitemradio" ${row.slug ? `data-model-id="${escape(row.slug)}"` : ''} ${row.hidden ? 'hidden' : ''}>${escape(row.title)}</div>`).join('');
  const answer = layout === 'current' ? `<div data-turn-key="fixture"><div data-talvt-turn-state="${complete ? 'complete' : 'in_progress'}"><div data-content-search-unit-key="fixture:assistant">Answer</div></div></div>`
    : layout === 'legacy' ? `<article data-message-status="${complete ? 'finished_successfully' : 'in_progress'}"><div data-message-author-role="assistant">Answer</div></article>` : '';
  return `<!doctype html><html><head><title>${challenge === 'title' ? 'Just a moment' : 'Adapter fixture'}</title></head><body>
    ${temporary ? '<span data-testid="temporary-chat-indicator">Temporary chat</span>' : ''}
    ${composer === 'textarea' ? '<textarea aria-label="Message"></textarea>' : composer === 'editable' ? '<div id="prompt-textarea" contenteditable="true" role="textbox"></div>' : ''}
    ${picker === 'missing' || picker === 'direct' ? '' : (picker === 'hidden-first' ? `<div hidden>${trigger}</div>` : '') + trigger + (picker === 'duplicate' ? trigger : '')}
    <div role="menu">${picker === 'direct' ? entries : ''}</div>
    ${challenge === 'iframe' ? '<iframe title="Verification challenge" src="about:blank"></iframe>' : ''}
    ${rate ? `<div role="dialog">${escape(rate)}</div>` : ''}${signIn ? '<button>Log in</button>' : ''}
    ${images ? '<input type="file" multiple accept="image/*">' : ''}${answer}
    <script>
      const entries = ${JSON.stringify(entries).replaceAll('<', '\\u003c')};
      const menu = document.querySelector('[role="menu"]');
      const bind = () => { for (const row of menu.children) row.onclick = () => { window.selected = row.getAttribute('data-model-id') || row.textContent; }; };
      const render = () => { menu.innerHTML = entries; bind(); };
      for (const [index, trigger] of [...document.querySelectorAll('[data-codex-intelligence-trigger]')].entries()) trigger.onclick = () => {
        window.openedTrigger = index;
        if (['effort', 'effort-unmatched'].includes(${JSON.stringify(picker)})) {
          menu.innerHTML = '<div role="menuitem" data-model-picker-view-toggle="true">Models</div><div role="menuitemradio">' + (${JSON.stringify(picker)} === 'effort' ? 'GPT-6' : 'Instant') + '</div>';
          menu.firstChild.onclick = () => { window.toggleClicked = true; menu.replaceChildren(); setTimeout(render, 100); };
        } else if (${JSON.stringify(picker)} === 'toggle') {
          menu.innerHTML = '<div role="menuitem" data-model-picker-view-toggle="true">Models</div>';
          menu.firstChild.onclick = () => { menu.replaceChildren(); setTimeout(render, 100); };
        } else render();
      };
      bind();
      document.querySelector('input')?.addEventListener('change', () => {
        window.uploaded = [...document.querySelector('input').files].map(file => ({ name: file.name, type: file.type, size: file.size }));
        if (${rejectImage}) { const alert = document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Image upload failed'; document.body.append(alert); }
      });
    </script></body></html>`;
}

export async function createTurnFixture({ interval = 450, stall = 0, siteAdapter } = {}) {
  const requests = [];
  let mode = 'normal';
  const batches = ['A floating garden rises above the water. ', 'Its silver leaves collect the morning rain. ', 'A narrow path leads back to the quiet shore.'];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/backend-api/f/conversation') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const submitted = JSON.parse(body);
      requests.push(submitted);
      const marker = submitted.prompt.match(/\[MAGPIE_TOOL_([a-f0-9]{32})\]/);
      const scripted = marker ? ['Before the call. ', `[MAGPIE_TOOL_${marker[1]}]${JSON.stringify({ name: 'lookup', input: { query: 'garden' } })}[/MAGPIE_TOOL_${marker[1]}]`, 'After the call.'] : batches;
      if ((mode.startsWith('xhr-') || mode.startsWith('app-shell-')) && mode !== 'app-shell-script') {
        const headers = { 'content-type': mode === 'xhr-interstitial' ? 'text/html' : 'application/json' };
        if (['xhr-challenge', 'app-shell-challenge'].includes(mode)) headers['cf-mitigated'] = 'challenge';
        response.writeHead(mode === 'xhr-expired' ? 401 : mode === 'xhr-rate' ? 429 : 403, { ...headers, 'retry-after': '120' });
        response.end(mode === 'xhr-interstitial' ? '<title>Just a moment</title>Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform/' : '{}');
        return;
      }
      if (['post-challenge', 'post-expired', 'post-forbidden'].includes(mode)) {
        response.writeHead(mode === 'post-expired' ? 401 : 403, { 'content-type': mode === 'post-challenge' ? 'text/html' : 'application/json' });
        response.end(mode === 'post-challenge' ? '<title>Just a moment</title>Enable JavaScript and cookies to continue /cdn-cgi/challenge-platform/' : '{}');
        return;
      }
      if (mode === 'upstream-reject') { request.socket.destroy(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await delay(stall);
      if (mode === 'changed') { frame('changed_encoding', {}); response.end(); return; }
      if (mode.startsWith('present-')) {
        if (['present-handoff', 'present-handoff-done', 'present-handoff-failure'].includes(mode)) for (const item of handoffFrames) frame(item.event, item.data);
        if (mode === 'present-handoff-done') response.write('data: [DONE]\n\n');
        response.end(); return;
      }
      frame('delta_encoding', 'v1');
      frame('delta', { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', channel: 'final', content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: mode === 'hidden' }, status: 'in_progress' } } });
      if (!['empty', 'hidden'].includes(mode)) for (const [index, batch] of scripted.entries()) {
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
    if (url.pathname.startsWith('/cdn-cgi/challenge-platform/')) { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end('// Offline challenge marker; no challenge execution.'); return; }
    response.setHeader('content-type', 'text/html');
    if (siteAdapter) { response.end(siteAdapterHtml(siteAdapter)); return; }
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Local chat fixture</title></head><body>
      <button aria-label="Open profile menu">Fixture account</button><p>Temporary chat</p>
      <main id="messages"></main><textarea aria-label="Message"></textarea>
      <script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload"></script>
      <script>
      const mode = ${JSON.stringify(mode)};
      const input = document.querySelector('textarea');
      let conversation = location.pathname.startsWith('/c/') ? location.pathname.slice(3) : crypto.randomUUID();
      if (!['normal', 'app-shell-script'].includes(mode)) document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]').remove();
      if (mode === 'clone-failure') Response.prototype.clone = function () { throw new Error('fixture refuses clone'); };
      if (mode === 'present-handoff-failure') Response.prototype.clone = function () {
        return new Response(this.body.pipeThrough(new TransformStream({
          flush(controller) { controller.error(new Error('fixture post-handoff reader crash')); },
        })));
      };
      if (mode === 'page-shape') document.body.append(input.cloneNode());
      input.addEventListener('keydown', async event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (mode === 'rate' || mode === 'challenge') {
          const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
          dialog.textContent = mode === 'rate' ? 'You have reached the usage limit' : 'Verify you are human';
          document.body.append(dialog); return;
        }
        if (mode.startsWith('present-')) {
          const main = document.querySelector('main');
          const turn = document.createElement('div');
          turn.setAttribute('data-turn-key', 'fixture-turn');
          turn.innerHTML = '<div data-content-search-turn-key="fallback-turn-0"><div><div data-talvt-turn-state="complete"><div><div><h4>你说：</h4><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="fixture-user"><div data-content-search-unit-key="fallback-turn-0:0:user"><div id="user-text"></div></div></div></div><div>思考了 23s</div><div id="assistant-wrapper"></div></div></div></div></div>';
          turn.querySelector('#user-text').textContent = input.value;
          const stop = document.createElement('button'); stop.setAttribute('aria-label', '停止');
          main.append(turn, stop);
          const state = turn.querySelector('[data-talvt-turn-state]');
          const stages = window.fixtureStages = [];
          const record = phase => stages.push({ phase });
          record('user-only');
          window.advancePresentTurn = phase => {
            if (phase === 'answer') {
              state.setAttribute('data-talvt-turn-state', 'in_progress');
              turn.querySelector('#assistant-wrapper').innerHTML = '<div data-content-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="fixture-assistant fixture-assistant"><h4 data-conversation-role="assistant">ChatGPT 说：</h4><div style="white-space: pre-wrap"></div></div><span></span>';
              turn.querySelector('[data-conversation-role="assistant"] + div').textContent = mode === 'present-challenge' ? 'cloudflare_challenge' : 'ORCA_DOM_ALPHA';
            }
            if (phase === 'grow') turn.querySelector('[data-conversation-role="assistant"] + div').textContent += '\\nORCA_DOM_BETA\\nORCA_DOM_GAMMA';
            if (phase === 'complete-with-stop' || phase === 'complete') state.setAttribute('data-talvt-turn-state', 'complete');
            if (phase === 'complete' || phase === 'in-progress-no-stop') stop.remove();
            record(phase);
          };
          history.replaceState(null, '', '/c/' + conversation);
          await fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ conversation, prompt: input.value }) });
          input.value = '';
          return;
        }
        const article = document.createElement('article');
        const answer = document.createElement('div'); answer.setAttribute('aria-label', 'Assistant response');
        article.append(answer); document.querySelector('main').append(article);
        const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop generating'); document.body.append(stop);
        history.replaceState(null, '', '/c/' + conversation);
        if ((mode.startsWith('xhr-') || mode.startsWith('app-shell-')) && mode !== 'app-shell-script') {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/backend-api/f/conversation');
          xhr.addEventListener('load', () => {
            stop.remove();
            if (mode.startsWith('app-shell-')) {
              const error = document.createElement('p'); error.textContent = 'cloudflare_challenge'; answer.append(error);
              const retry = document.createElement('button'); retry.textContent = 'Retry'; article.append(retry);
              if (mode !== 'app-shell-card') { const script = document.createElement('script'); script.src = '/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload'; document.head.append(script); }
              const sandbox = document.createElement('iframe'); sandbox.title = 'DIL execution sandbox'; sandbox.src = 'about:blank'; document.body.append(sandbox);
            }
          });
          xhr.send(JSON.stringify({ conversation, prompt: input.value })); input.value = ''; return;
        }
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
              if (operation.p === '/message/status') { completed = true; if (mode !== 'hidden') article.setAttribute('data-message-status', 'finished_successfully'); }
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
