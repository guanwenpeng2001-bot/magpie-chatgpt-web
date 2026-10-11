export function installHarvest() {
  if (window.__chatgptHarvest) return;
  let active;
  const send = value => {
    if (!active) return;
    const run = active;
    run.pending = run.pending.then(() => window.__chatgptHarvestEvent({ turn: run.id, ...value })).catch(() => { run.failed = true; });
  };
  const state = window.__chatgptHarvest = {
    start(id, network = true) {
      active = { id, network, pending: Promise.resolve(), readers: new Set(), baseline: new Set(document.querySelectorAll('[data-dil-message-id], [data-message-author-role="assistant"], [aria-label="Assistant response"]')) };
    },
    stop() {
      const run = active;
      active = undefined;
      for (const reader of run?.readers ?? []) reader.cancel().catch(() => {});
    },
    snapshot() {
      const nodes = [...document.querySelectorAll('[data-dil-message-id], [data-message-author-role="assistant"], [aria-label="Assistant response"]')].filter(node => !active?.baseline.has(node));
      const node = nodes.at(-1);
      const stop = [...document.querySelectorAll('button')].some(button => /stop (generating|streaming)|停止生成|停止流式传输/i.test(button.getAttribute('aria-label') ?? button.textContent));
      const finished = !!node && [...(node.closest('article') ?? node.parentElement ?? node).querySelectorAll('button')].some(button => /copy|复制|read aloud|朗读/i.test(button.getAttribute('aria-label') ?? button.textContent));
      return { text: node?.innerText ?? '', stop, finished, failed: active?.failed ?? false, nodes: nodes.length };
    },
  };
  const conversation = input => {
    try { return /^\/backend-api\/(?:f\/)?conversation$/.test(new URL(typeof input === 'string' ? input : input.url, location.href).pathname); }
    catch { return false; }
  };
  async function read(response, run) {
    let reader;
    try { reader = response.clone().body.getReader(); }
    catch { send({ kind: 'fallback', reason: 'clone' }); return; }
    run.readers.add(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (active === run) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = '';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length) send({ kind: 'frame', frame: { event, data: data.join('\n') } });
        }
        if (buffer.length > 4 * 1024 * 1024) { send({ kind: 'failure', code: 'protocol' }); break; }
        if (done) { send({ kind: 'eof', partial: !!buffer.trim() }); break; }
        await run.pending;
      }
    } catch { if (active === run) send({ kind: 'failure', code: 'harvest' }); }
    finally { run.readers.delete(reader); reader.cancel().catch(() => {}); }
  }
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const run = active;
    const relevant = run && conversation(args[0]);
    let response;
    try { response = await originalFetch.apply(this, args); }
    catch (error) { if (relevant && active === run) send({ kind: 'failure', code: 'upstream' }); throw error; }
    if (relevant && active === run) {
      const evidence = { mitigated: response.headers.get('cf-mitigated') === 'challenge', interstitial: false };
      if (response.status === 403 && !evidence.mitigated && /text\/html/i.test(response.headers.get('content-type') ?? '')) {
        let reader;
        try {
          reader = response.clone().body.getReader();
          const decoder = new TextDecoder();
          let body = '';
          let bytes = 0;
          while (bytes < 65536) {
            const { value, done } = await reader.read();
            if (done) break;
            body += decoder.decode(value.subarray(0, 65536 - bytes), { stream: true });
            bytes += value.byteLength;
          }
          evidence.interstitial = body.includes('/cdn-cgi/challenge-platform') && /Enable JavaScript and cookies to continue|Just a moment/i.test(body);
        } catch {} finally { reader?.cancel().catch(() => {}); }
      }
      if (active === run) send({ kind: 'status', status: response.status, retryAfter: response.headers.get('retry-after'), ...evidence });
      if (response.ok) {
        if (run.network) void read(response, run);
        else send({ kind: 'fallback', reason: 'disabled' });
      }
    }
    return response;
  };
  const open = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__chatgptConversation = conversation(String(url));
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (active && this.__chatgptConversation) {
      send({ kind: 'fallback', reason: 'xhr' });
      this.addEventListener('load', () => send({ kind: 'status', status: this.status, mitigated: false, interstitial: false }));
      this.addEventListener('error', () => send({ kind: 'failure', code: 'upstream' }));
    }
    return xhrSend.apply(this, args);
  };
}
