import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isCompaction } from './fallback.mjs';

const paths = new Set(['/v1/responses', '/v1/responses/compact']);
const forwardedNames = ['x-codex-turn-metadata', 'x-codex-beta-features', 'session_id', 'conversation_id'];

export function compactionProxy({ port, controlToken }, fetchImpl = globalThis.fetch) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid compaction daemon port');
  return (body, headers, signal, path = '/v1/responses/compact') => {
    const endpoint = path.endsWith('/responses/compact') ? '/v1/responses/compact' : '/v1/responses';
    const incoming = new Headers(headers);
    const forwarded = new Headers({ 'content-type': 'application/json',
      accept: endpoint.endsWith('/compact') || body.stream !== true ? 'application/json' : 'text/event-stream' });
    for (const name of forwardedNames) if (incoming.has(name)) forwarded.set(name, incoming.get(name));
    forwarded.set('authorization', `Bearer ${controlToken}`);
    // The reference only merges this header itself on /responses/compact. Header-only
    // Responses compaction must reach its parser with the same canonical metadata.
    const metadata = incoming.get('x-codex-turn-metadata');
    if (metadata !== null) body = { ...body, client_metadata: { ...body.client_metadata, 'x-codex-turn-metadata': metadata } };
    return fetchImpl(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST', headers: forwarded, body: JSON.stringify(body), signal, redirect: 'error',
    });
  };
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Account-owned loopback endpoint; only its browser-only child is started on demand.
 * Reference v6.1.18: config.ts:645 disables localToolsEnabled in browser-only;
 * adapters/chatgpt-web/index.ts:935-951 then bypasses the launcher handoff gate,
 * reaching startRuntime's read-only worker at :731. Keep response bytes native:
 * server.ts:962 builds v1 replacement history; parser.ts:637-647 selects memento/v2.
 */
export class CompactionService {
  constructor(owner, { writePrivate, idleMs = 60_000 } = {}) {
    Object.assign(this, { owner, writePrivate, idleMs });
    this.home = join(owner.home, 'compaction');
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
    clearTimeout(this.idleTimer);
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
      await abortable(this.start(), controller.signal);
      controller.signal.throwIfAborted();
      const response = await compactionProxy(this.config, this.owner.fetch)(body, req.headers, controller.signal, req.url);
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
      this.scheduleIdle();
    }
  }

  start() {
    if (this.closed) return Promise.reject(new Error('Compaction service stopped'));
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.ready) return Promise.resolve();
    this.controller = new AbortController();
    this.starting = this.launch(this.controller.signal).catch(async error => {
      await this.stopChild();
      throw error;
    }).finally(() => { this.starting = null; this.scheduleIdle(); });
    return this.starting;
  }

  async launch(signal) {
    const owner = this.owner;
    const port = await owner.allocatePort();
    const storageStatePath = join(this.home, 'browser', 'storage-state.json');
    await this.writePrivate(storageStatePath, JSON.stringify(await owner.storageState()));
    await this.writePrivate(`${storageStatePath}.verified.json`, JSON.stringify({ version: 1, authenticated: true,
      verifiedAt: new Date().toISOString(), ...owner.capabilities }));
    // No tunnel, launcher descriptor, retained-browser profile, or tool broker shared
    // with the full daemon. Only the signed-in storage snapshot/capabilities are copied.
    this.config = { version: 3, releaseVersion: '6.1.18', mode: 'browser-only', subagentProtocol: 'native',
      host: '127.0.0.1', port, contextWindow: 256000, appName: owner.appName,
      browserHost: 'managed-chrome', browserInteractionMode: 'automatic',
      chromeExecutablePath: owner.chromeExecutablePath, storageStatePath,
      solAvailable: owner.capabilities.solAvailable === true, proAvailable: owner.capabilities.proAvailable === true,
      extraHighAvailable: owner.capabilities.extraHighAvailable === true, experimentalBiggerContext: false,
      brokerSocketPath: '\\\\.\\pipe\\magpie-compaction-' + randomUUID(), headed: false, autoApproveToolCalls: false,
      acknowledgedUnofficialAt: new Date().toISOString(), controlToken: randomBytes(32).toString('base64url'),
      runtimeCommand: owner.runtimeCommand };
    await this.writePrivate(join(this.home, 'config.json'), JSON.stringify(this.config));
    const inherited = Object.fromEntries(Object.entries(owner.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
    const env = { ...inherited, CODEX_CHATGPT_WEB_HOME: this.home, CODEX_HOME: join(this.home, 'codex') };
    await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    signal = AbortSignal.any([signal, AbortSignal.timeout(owner.startupTimeoutMs)]);
    signal.throwIfAborted();
    const child = owner.spawn(owner.runtimeCommand[0], [...owner.runtimeCommand.slice(1), 'serve'], {
      cwd: this.home, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.child = child;
    this.childDone = new Promise(resolve => {
      const failed = () => {
        resolve();
        if (this.child === child) { this.ready = false; this.controller.abort(); }
      };
      child.once('error', failed);
      child.once('exit', failed);
    });
    await owner.waitFor(async () => {
      try {
        const response = await owner.fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: 'error',
        });
        const health = await response.json();
        return response.ok && health.service === 'codex-chatgpt-web' && health.mode === 'browser-only' && health.accepting_turns !== false;
      } catch { return false; }
    }, signal);
    signal.throwIfAborted();
    this.ready = true;
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.closed || this.active || this.starting) return;
    this.idleTimer = setTimeout(() => { void this.stopChild(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  stopChild() {
    if (this.stopping) return this.stopping;
    const wasReady = this.ready;
    this.ready = false;
    this.controller?.abort();
    const child = this.child;
    this.child = null;
    this.stopping = (async () => {
      if (!child) return;
      const waitForExit = async () => {
        let timer;
        const exited = await Promise.race([this.childDone.then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        clearTimeout(timer);
        return exited;
      };
      if (wasReady) {
        try {
          // Windows kill() cannot run Bun's SIGTERM cleanup. The reference admin
          // handshake closes Playwright browsers before stopping its HTTP listener.
          for (const action of ['drain', 'cancel-turns', 'shutdown']) {
            const response = await this.owner.fetch(`http://127.0.0.1:${this.config.port}/admin/${action}`, {
              method: 'POST', headers: { authorization: `Bearer ${this.config.controlToken}` },
              signal: AbortSignal.timeout(2000), redirect: 'error',
            });
            if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Compaction shutdown refused');
          }
          if (await waitForExit()) return;
        } catch { /* bounded forced cleanup if the child is unhealthy */ }
      }
      child.kill();
      await waitForExit();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async stop() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.controller?.abort();
    for (const controller of this.requests) controller.abort();
    const closed = this.server ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve();
    this.server?.closeAllConnections();
    await this.starting?.catch(() => {});
    await this.stopChild();
    await closed;
  }
}
