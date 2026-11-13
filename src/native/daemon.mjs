import { spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeOptions as normalizeNativeOptions } from './models.mjs';
import { CompactionService, compactionProxy } from './compaction.mjs';

export async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

// The OS owns this lease: no PID files, and no probing/unlinking a live owner's
// endpoint. Windows pipes and Linux abstract sockets disappear on process exit.
async function lockAccount(home) {
  const normalized = resolve(home);
  const identity = createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex');
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\magpie-native-owner-' + identity
    : process.platform === 'linux' ? '\0magpie-native-owner-' + identity
      : join('/tmp', 'mno-' + identity + '.sock');
  const server = createServer(socket => socket.destroy());
  await new Promise((resolveLock, reject) => {
    server.once('error', () => reject(new Error('Native daemon account ownership unavailable')));
    server.listen(address, () => { server.unref(); resolveLock(); });
  });
  return server;
}

export const quoteMcpCommand = args => args.map(arg => '"' + String(arg).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"').join(' ');

export function daemonProxy({ port, controlToken, compaction }, fetchImpl = globalThis.fetch) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native daemon port');
  const base = `http://127.0.0.1:${port}`;
  return {
    ...(compaction ? { compaction: compactionProxy(compaction, fetchImpl) } : {}),
    async health(signal) {
      try {
        const response = await fetchImpl(`${base}/healthz`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000), redirect: 'error' });
        const data = await response.json();
        return response.ok && data.service === 'codex-chatgpt-web' && data.mode === 'full' && data.accepting_turns !== false;
      } catch { return false; }
    },
    responses(body, headers, signal) {
      const forwarded = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
      const incoming = new Headers(headers);
      for (const name of ['x-codex-turn-metadata', 'x-codex-beta-features', 'session_id', 'conversation_id']) {
        if (incoming.has(name)) forwarded.set(name, incoming.get(name));
      }
      // The control credential belongs only to this account's loopback daemon.
      if (controlToken) forwarded.set('authorization', `Bearer ${controlToken}`);
      return fetchImpl(`${base}/v1/responses`, { method: 'POST', headers: forwarded, body: JSON.stringify(body), signal, redirect: 'error' });
    },
  };
}

export class NativeDaemon {
  constructor({ home, runtimeCommand, tunnelBinary, chromeExecutablePath, browserEndpoint, storageState, capabilities = {}, nativeOptions, appName = 'Codex Magpie',
    spawn = spawnProcess, fetch = globalThis.fetch, allocatePort = freePort, sleep = delay,
    startupTimeoutMs = 30_000, pollMs = 200, restartBaseMs = 1000, restartMaxMs = 30_000, env = process.env,
    compactionIdleMs = 60_000, shutdownRequestTimeoutMs = 2000, shutdownExitTimeoutMs = 5000 }) {
    Object.assign(this, { home, runtimeCommand, tunnelBinary, chromeExecutablePath, browserEndpoint, storageState, capabilities, appName,
      spawn, fetch, allocatePort, sleep, startupTimeoutMs, pollMs, restartBaseMs, restartMaxMs, env,
      shutdownRequestTimeoutMs, shutdownExitTimeoutMs });
    this.nextOptions = normalizeNativeOptions(nativeOptions);
    this.nextCapabilities = capabilities;
    this.home = resolve(home);
    this.commandChildren = new Set();
    this.ready = false;
    this.desired = false;
    this.failures = 0;
    this.compactionIdleMs = compactionIdleMs;
  }
  configure(options, capabilities = this.nextCapabilities) {
    this.nextOptions = normalizeNativeOptions(options);
    this.nextCapabilities = capabilities;
  }
  descriptor() { return { port: this.config.port, controlToken: this.config.controlToken, capabilities: { ...this.capabilities, experimentalBiggerContext: this.config.experimentalBiggerContext, useTemporaryChats: this.config.useTemporaryChats },
    ...(this.compactionService ? { compaction: this.compactionService.descriptor() } : {}) }; }
  start(credentials) {
    if (this.stopping) return this.stopping.then(() => this.start(credentials));
    this.credentials = credentials ?? this.credentials;
    this.desired = true;
    if (this.starting) return this.starting;
    if (this.ready) return Promise.resolve(this);
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.controller = new AbortController();
    this.starting = this.launch(this.controller.signal).catch(async () => {
      this.ready = false;
      if (!this.ownerLock) this.desired = false; // A contender must never steal a later lease by retrying.
      else {
        try {
          await this.cleanup();
          // A running daemon keeps its lease across crash recovery/backoff.
          if (!this.startedAt || !this.desired) await this.releaseOwnership();
        } catch { /* retain ownership and pending cleanup for stop/start retry */ }
      }
      throw new Error('Native daemon startup failed');
    }).finally(() => { this.starting = null; if (this.desired && !this.ready) this.scheduleRestart(); });
    return this.starting;
  }
  async launch(signal) {
    const { tunnelId, runtimeKey } = this.credentials ?? {};
    if (!tunnelId || !runtimeKey) throw new Error('Native tunnel is not provisioned');
    signal.throwIfAborted();
    this.ownerLock ??= await lockAccount(this.home);
    // Explicit retries must finish the previous generation before replacing config.
    await this.cleanup();
    signal.throwIfAborted();
    this.capabilities = this.nextCapabilities;
    const settings = { ...this.nextOptions };
    const port = await this.allocatePort();
    const storageStatePath = join(this.home, 'browser/storage-state.json');
    const runtimeKeyFile = join(this.home, 'runtime.key');
    await writePrivate(runtimeKeyFile, runtimeKey);
    await writePrivate(storageStatePath, JSON.stringify(await this.storageState()));
    // Exact reference writeVerificationMarker shape (capabilities come from the signed-in account).
    await writePrivate(`${storageStatePath}.verified.json`, JSON.stringify({ version: 1, authenticated: true,
      verifiedAt: new Date().toISOString(), ...this.capabilities }));
    this.config = { version: 3, releaseVersion: '6.1.18', mode: 'full', subagentProtocol: 'native',
      host: '127.0.0.1', port, contextWindow: 256000, appName: this.appName, browserHost: 'managed-chrome',
      solAvailable: this.capabilities.solAvailable === true, proAvailable: this.capabilities.proAvailable === true,
      extraHighAvailable: this.capabilities.extraHighAvailable === true, ...settings,
      browserInteractionMode: 'automatic', chromeExecutablePath: this.chromeExecutablePath, storageStatePath,
      brokerSocketPath: '\\\\.\\pipe\\magpie-native-' + randomUUID(), headed: false, autoApproveToolCalls: false,
      acknowledgedUnofficialAt: new Date().toISOString(), controlToken: randomBytes(32).toString('base64url'),
      runtimeCommand: this.runtimeCommand,
      tunnel: { binaryPath: this.tunnelBinary, tunnelId, runtimeKeyFile, profileDir: join(this.home, 'tunnel'),
        profileName: 'magpie', alias: 'magpie-' + randomUUID() } };
    await writePrivate(join(this.home, 'config.json'), JSON.stringify(this.config));
    // Isolate all reference Codex state, including its model-catalog configuration reads.
    const inherited = Object.fromEntries(Object.entries(this.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
    const trustedHomes = [...new Set([
      this.env.CODEX_HOME ? resolve(this.env.CODEX_HOME) : null,
      resolve(homedir(), '.codex'),
    ].filter(dir => dir && isAbsolute(dir) && existsSync(dir)))];
    this.childEnv = { ...inherited, MAGPIE_NATIVE_CHECKPOINT_HOME: this.home, CODEX_CHATGPT_WEB_HOME: this.home, CODEX_HOME: join(this.home, 'codex'),
      ...(this.browserEndpoint ? { MAGPIE_NATIVE_BROWSER_CDP: this.browserEndpoint } : {}),
      ...(trustedHomes.length ? { CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES: JSON.stringify(trustedHomes) } : {}),
      TUNNEL_CLIENT_STATE_DIR: join(this.home, 'tunnel-state'), TUNNEL_CLIENT_PROFILE_DIR: join(this.home, 'tunnel'),
      MCP_STDIO_SEND_INITIALIZED_NOTIFICATION: 'true' };
    await mkdir(this.childEnv.CODEX_HOME, { recursive: true, mode: 0o700 });
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.startupTimeoutMs)]);
    signal.throwIfAborted();
    const child = this.spawn(this.runtimeCommand[0], [...this.runtimeCommand.slice(1), 'serve'], {
      cwd: this.home, env: this.childEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.child = child;
    const childState = this.childState = { exited: false, httpReady: false };
    const failed = () => {
      if (this.child !== child) return;
      this.ready = false;
      this.controller.abort();
      if (!this.starting && !this.cleaning && this.desired) this.scheduleRestart();
    };
    this.childDone = new Promise(resolve => {
      child.once('error', () => { childState.exited = true; resolve(); failed(); });
      child.once('exit', () => { childState.exited = true; resolve(); failed(); });
    });
    this.proxy = daemonProxy(this.descriptor(), this.fetch);
    await this.waitFor(() => this.proxy.health(signal), signal);
    childState.httpReady = true;
    const tunnel = this.config.tunnel;
    await this.removeStaleAliases(tunnel, signal);
    this.tunnelPending = true; // connect can fail after creating local state.
    await this.command(['runtimes', 'connect', '--alias', tunnel.alias, '--profile', tunnel.profileName,
      '--profile-dir', tunnel.profileDir, '--tunnel-client-bin', tunnel.binaryPath, '--tunnel-id', tunnelId,
      '--runtime-api-key', `file:${runtimeKeyFile}`, '--mcp-command', quoteMcpCommand([...this.runtimeCommand,
        'mcp', '--contract', 'native', '--broker-socket', this.config.brokerSocketPath]), '--json'], signal);
    await this.waitFor(async () => {
      const status = await this.command(['runtimes', 'status', tunnel.alias, '--json'], signal);
      return status.process_running === true && status.healthy === true && status.ready === true;
    }, signal);
    signal.throwIfAborted();
    this.compactionService = new CompactionService(this, { writePrivate, idleMs: this.compactionIdleMs });
    await this.compactionService.listen();
    signal.throwIfAborted();
    this.ready = true;
    this.startedAt = Date.now();
    return this;
  }
  async waitFor(check, signal) {
    for (let i = 0; i <= Math.ceil(this.startupTimeoutMs / this.pollMs); i++) {
      signal.throwIfAborted();
      if (await check()) return;
      await this.sleep(this.pollMs, undefined, { signal });
    }
    throw new Error('Native daemon readiness timed out');
  }
  // Each launch connects a fresh alias. Earlier aliases of this account's
  // profile are stopped and their local metadata removed; the remote tunnel
  // itself is kept (`runtimes rm` deletes only local metadata).
  async removeStaleAliases(tunnel, signal) {
    const listed = await this.command(['runtimes', 'list', '--json'], signal);
    if (!Array.isArray(listed?.aliases)) throw new Error('Invalid native tunnel inventory');
    const owned = resolve(tunnel.profileDir).toLowerCase();
    const stale = listed.aliases
      .filter(entry => entry && typeof entry.alias === 'string' && entry.alias !== tunnel.alias
        && /^magpie-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.alias)
        && typeof entry.profile_dir === 'string' && resolve(entry.profile_dir).toLowerCase() === owned
        && (entry.tunnel_id === undefined || entry.tunnel_id === tunnel.tunnelId))
      .map(entry => entry.alias);
    for (const alias of stale) {
      signal.throwIfAborted();
      await this.removeAlias(alias, signal);
    }
  }
  async removeAlias(alias, signal) {
    try {
      await this.command(['runtimes', 'stop', alias, '--json'], signal);
      await this.command(['runtimes', 'rm', alias, '--json'], signal);
    } catch {
      // A failed/aborted connect or an earlier partial rm may leave no alias.
      // Only a successful inventory proving absence makes cleanup idempotent.
      try {
        signal?.throwIfAborted();
        const listed = await this.command(['runtimes', 'list', '--json'], signal);
        if (Array.isArray(listed?.aliases) && !listed.aliases.some(entry => entry?.alias === alias)) return;
      } catch { /* report a sanitized failure below */ }
      throw new Error('Native tunnel cleanup failed');
    }
  }
  async releaseOwnership() {
    const lock = this.ownerLock;
    if (!lock) return;
    if (this.commandChildren.size) throw new Error('Native tunnel command still running');
    await new Promise((resolveClose, reject) => lock.close(error => error ? reject(new Error('Native daemon ownership release failed')) : resolveClose()));
    this.ownerLock = null;
    this.startedAt = undefined;
  }
  command(args, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      let output = '', settled = false;
      // The broker's MCP subprocess reads no checkpoints and must not become
      // a second store owner through the tunnel client's inherited environment.
      const { MAGPIE_NATIVE_CHECKPOINT_HOME: _checkpointHome, ...tunnelEnv } = this.childEnv;
      const child = this.spawn(this.tunnelBinary, args, { cwd: this.home, env: tunnelEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      this.commandChildren.add(child);
      const finish = (error, data) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { child.kill(); reject(new Error('Native tunnel command failed')); } else resolve(data);
      };
      const abort = () => finish(true);
      const timer = setTimeout(abort, this.startupTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', abort);
      child.stdout.on('data', bytes => { output += bytes; if (output.length > 1 << 20) finish(true); });
      child.once('close', code => {
        this.commandChildren.delete(child);
        if (code !== 0) return finish(true);
        try { finish(false, output.trim() ? JSON.parse(output) : {}); } catch { finish(true); }
      });
      if (signal?.aborted) abort();
    });
  }
  scheduleRestart() {
    if (this.restartTimer || !this.desired) return;
    if (this.startedAt && Date.now() - this.startedAt > 60_000) this.failures = 0;
    const backoff = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(this.failures++, 10));
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.cleanup();
        if (this.desired) await this.start();
      } catch {
        // Cleanup keeps the lease and old alias; retry before creating another.
        if (this.desired) this.scheduleRestart();
      }
    }, backoff);
    this.restartTimer.unref?.();
  }
  async health(signal) {
    if (!this.ready || !await this.proxy.health(signal)) return false;
    try {
      const status = await this.command(['runtimes', 'status', this.config.tunnel.alias, '--json'], signal);
      return status.process_running === true && status.healthy === true && status.ready === true;
    } catch { return false; }
  }
  responses(body, headers, signal) { return this.proxy.responses(body, headers, signal); }
  cleanup() {
    if (this.cleaning) return this.cleaning;
    if (!this.ownerLock) return Promise.resolve();
    const compactionService = this.compactionService;
    const child = this.child;
    const done = this.childDone;
    const childState = this.childState;
    const config = this.config;
    this.ready = false;
    this.cleaning = (async () => {
      try { await compactionService?.stop(); this.compactionService = null; }
      finally {
        try {
          if (child && !childState.exited) {
            const waitForExit = async () => {
              let timer;
              try {
                return await Promise.race([done.then(() => true), new Promise(resolve => {
                  timer = setTimeout(() => resolve(false), this.shutdownExitTimeoutMs);
                })]);
              } finally { clearTimeout(timer); }
            };
            if (childState.httpReady) {
              try {
                // Windows kill() bypasses Bun's signal handlers. Let the reference
                // cancel active turns, flush state and close its browsers first.
                for (const action of ['drain', 'cancel-turns', 'shutdown']) {
                  const response = await this.fetch(`http://127.0.0.1:${config.port}/admin/${action}`, {
                    method: 'POST', headers: { authorization: `Bearer ${config.controlToken}` },
                    signal: AbortSignal.timeout(this.shutdownRequestTimeoutMs), redirect: 'error',
                  });
                  if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Native shutdown refused');
                }
                await waitForExit();
              } catch { /* bounded forced cleanup when the daemon cannot shut down */ }
            }
            if (!childState.exited) { child.kill(); await waitForExit(); }
            if (!childState.exited) throw new Error('Native daemon shutdown failed');
          }
          this.child = null;
        } finally {
          // Cancellation may still need the MCP connection until the daemon exits.
          if ((!child || childState.exited) && this.tunnelPending && config?.tunnel) {
            await this.removeAlias(config.tunnel.alias);
            this.tunnelPending = false;
          }
        }
      }
      // kill() requests termination; a late command can still mutate alias state
      // until close. Keep the lease and block a new generation in that interval.
      if (this.commandChildren.size) throw new Error('Native tunnel command still running');
    })().finally(() => { this.cleaning = null; });
    return this.cleaning;
  }
  stop(keepOwnership = false) {
    if (this.stopping) return this.stopping;
    this.desired = false; this.ready = false;
    clearTimeout(this.restartTimer); this.restartTimer = null;
    this.controller?.abort();
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.cleanup();
      if (!keepOwnership) await this.releaseOwnership();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async restart() { await this.stop(true); return this.start(); }
}
