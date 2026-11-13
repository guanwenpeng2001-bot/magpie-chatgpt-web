import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isCompaction } from './fallback.mjs';

const paths = new Set(['/v1/responses', '/v1/responses/compact']);
const forwardedNames = ['x-codex-turn-metadata', 'x-codex-beta-features', 'session_id', 'conversation_id'];

export function nativeTurnHeaders(body, headers) {
  const forwarded = new Headers(headers);
  const metadata = body.client_metadata?.['x-codex-turn-metadata'];
  if (metadata !== undefined) forwarded.set('x-codex-turn-metadata', typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  return forwarded;
}

export function compactionProxy({ port, controlToken }, fetchImpl = globalThis.fetch) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid compaction daemon port');
  return (body, headers, signal, path = '/v1/responses/compact') => {
    const endpoint = path.endsWith('/responses/compact') ? '/v1/responses/compact' : '/v1/responses';
    const incoming = nativeTurnHeaders(body, headers);
    const forwarded = new Headers({ 'content-type': 'application/json',
      accept: endpoint.endsWith('/compact') || body.stream !== true ? 'application/json' : 'text/event-stream' });
    for (const name of forwardedNames) if (incoming.has(name)) forwarded.set(name, incoming.get(name));
    forwarded.set('authorization', `Bearer ${controlToken}`);
    // The reference gives this header precedence on /responses/compact. Keep it
    // synchronized with canonical body metadata; fill the body only when absent.
    const metadata = incoming.get('x-codex-turn-metadata');
    if (body.client_metadata?.['x-codex-turn-metadata'] === undefined && metadata !== null) {
      body = { ...body, client_metadata: { ...body.client_metadata, 'x-codex-turn-metadata': metadata } };
    }
    return fetchImpl(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST', headers: forwarded, body: JSON.stringify(body), signal, redirect: 'error',
    });
  };
}

/** Account-owned authenticated endpoint. Compaction and normal Responses run in the
 * same full daemon so v6.1.18's process-local continuation checkpoints, task provenance,
 * and browser ownership survive until the next native turn. runtime.mjs selects the
 * reference read-only compaction path for automatic managed Chrome in that process.
 */
export class CompactionService {
  constructor(owner) {
    this.owner = owner;
    this.controlToken = randomBytes(32).toString('base64url');
    this.active = 0;
    this.closed = false;
    this.requests = new Set();
  }

  async listen() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.server.unref();
    return this;
  }

  descriptor() { return { port: this.server.address().port, controlToken: this.controlToken }; }

  async handle(req, res) {
    const fail = (status, code) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { type: 'upstream_error', code, message: code } }));
    };
    if (req.headers.authorization !== `Bearer ${this.controlToken}`) { fail(401, 'unauthorized'); return; }
    if (req.method !== 'POST' || !paths.has(req.url)) { fail(404, 'compaction_route_required'); return; }
    if (this.closed) { fail(503, 'compaction_stopped'); return; }
    const controller = new AbortController();
    this.requests.add(controller);
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    this.active++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { fail(413, 'compaction_request_too_large'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'invalid_compaction_request'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !isCompaction(body, req.url, req.headers)) {
        fail(400, 'compaction_request_required'); return;
      }
      controller.signal.throwIfAborted();
      const response = await compactionProxy(this.owner.config, this.owner.fetch)(body, req.headers, controller.signal, req.url);
      const headers = {};
      for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
        if (response.headers.has(name)) headers[name] = response.headers.get(name);
      }
      res.writeHead(response.status, headers);
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
      else res.end();
    } catch { fail(502, 'native_compaction_unavailable'); }
    finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      this.requests.delete(controller);
      this.active--;
    }
  }

  async stop() {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    const closed = this.server ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve();
    this.server?.closeAllConnections();
    await closed;
  }
}
