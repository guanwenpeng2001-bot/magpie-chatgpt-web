import { spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  constructor({ home, runtimeCommand, tunnelBinary, chromeExecutablePath, storageState, capabilities = {}, appName = 'Codex Magpie',
    spawn = spawnProcess, fetch = globalThis.fetch, allocatePort = freePort, sleep = delay,
    startupTimeoutMs = 30_000, pollMs = 200, restartBaseMs = 1000, restartMaxMs = 30_000, env = process.env,
    compactionIdleMs = 60_000 }) {
    Object.assign(this, { home, runtimeCommand, tunnelBinary, chromeExecutablePath, storageState, capabilities, appName,
      spawn, fetch, allocatePort, sleep, startupTimeoutMs, pollMs, restartBaseMs, restartMaxMs, env });
    this.ready = false;
    this.desired = false;
    this.failures = 0;
    this.compactionIdleMs = compactionIdleMs;
  }
  descriptor() { return { port: this.config.port, controlToken: this.config.controlToken, capabilities: this.capabilities,
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
      await this.cleanup();
      throw new Error('Native daemon startup failed');
    }).finally(() => { this.starting = null; if (this.desired && !this.ready) this.scheduleRestart(); });
    return this.starting;
  }
  async launch(signal) {
    const { tunnelId, runtimeKey } = this.credentials ?? {};
    if (!tunnelId || !runtimeKey) throw new Error('Native tunnel is not provisioned');
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
      extraHighAvailable: this.capabilities.extraHighAvailable === true, experimentalBiggerContext: false,
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
    this.childEnv = { ...inherited, CODEX_CHATGPT_WEB_HOME: this.home, CODEX_HOME: join(this.home, 'codex'),
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
    const failed = () => {
      if (this.child !== child) return;
      this.ready = false;
      this.controller.abort();
      if (!this.starting && this.desired) this.scheduleRestart();
    };
    this.childDone = new Promise(resolve => {
      child.once('error', () => { resolve(); failed(); });
      child.once('exit', () => { resolve(); failed(); });
    });
    this.proxy = daemonProxy(this.descriptor(), this.fetch);
    await this.waitFor(() => this.proxy.health(signal), signal);
    const tunnel = this.config.tunnel;
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
  command(args, signal) {
    return new Promise((resolve, reject) => {
      let output = '', settled = false;
      const child = this.spawn(this.tunnelBinary, args, { cwd: this.home, env: this.childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
      await this.cleanup();
      if (this.desired) void this.start().catch(() => {});
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
  async cleanup() {
    await this.compactionService?.stop();
    this.compactionService = null;
    const child = this.child;
    const done = this.childDone;
    this.child = null;
    if (this.config?.tunnel) await this.command(['runtimes', 'stop', this.config.tunnel.alias, '--json']).catch(() => {});
    child?.kill();
    if (child && done) {
      let timer;
      await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.desired = false; this.ready = false;
    clearTimeout(this.restartTimer); this.restartTimer = null;
    this.controller?.abort();
    this.stopping = (async () => { await this.starting?.catch(() => {}); await this.cleanup(); })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async restart() { await this.stop(); return this.start(); }
}
