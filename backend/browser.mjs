import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { challengeEvidence, responseFailure } from './http.mjs';
import { BackendError } from './guard.mjs';

// The sign-in window's single source of truth: one bounded default that the
// backend arms its abort from and the sign-in message renders from.
export const DEFAULT_SIGNIN_TIMEOUT_MS = 900_000;
// One unfinished sign-in's profile choice, stored in the profile root that
// outlives the backend process so a retry resumes the same Chrome profile.
export const SIGNIN_TIMEOUT_FILE = 'signin.profile';
const PROFILE_CLAIM = /^[a-zA-Z0-9_-]{1,64}$/;
export function signinWindow(milliseconds) {
  const minutes = milliseconds / 60_000;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function signinTimeoutWindow() {
  return signinWindow(DEFAULT_SIGNIN_TIMEOUT_MS);
}

const claimLocks = new Map();

async function lockSigninProfile(root) {
  if (!claimLocks.has(root)) {
    const identity = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
    const address = process.platform === 'win32' ? '\\\\.\\pipe\\magpie-signin-' + identity : '\0magpie-signin-' + identity;
    const server = createServer(socket => socket.destroy());
    const acquisition = new Promise((resolveLock, reject) => {
      server.once('error', error => {
        claimLocks.delete(root);
        if (error.code === 'EADDRINUSE') resolveLock(null);
        else reject(new BackendError('browserConfiguration'));
      });
      server.listen(address, () => { server.unref(); resolveLock(server); });
    });
    claimLocks.set(root, acquisition);
  }
  return claimLocks.get(root);
}

export async function signinProfileClaim(profileRoot, owner) {
  const root = resolve(profileRoot);
  try {
    mkdirSync(root, { recursive: true });
    const lock = await lockSigninProfile(root);
    if (!lock) return randomUUID();
    let stored;
    try { stored = readFileSync(join(root, SIGNIN_TIMEOUT_FILE), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stored || !PROFILE_CLAIM.test(stored)) {
      stored = randomUUID();
      writeFileSync(join(root, SIGNIN_TIMEOUT_FILE), stored);
    }
    lock.owners ??= new Map();
    lock.owners.set(owner ?? stored, stored);
    return stored;
  } catch { throw new BackendError('browserConfiguration'); }
}

export async function releaseSigninProfileClaim(profileRoot, owner) {
  const root = resolve(profileRoot);
  const lock = await claimLocks.get(root);
  if (!lock || (owner && !lock.owners.has(owner))) return;
  try {
    const pending = readFileSync(join(root, SIGNIN_TIMEOUT_FILE), 'utf8').trim();
    if (!owner || pending === lock.owners.get(owner)) rmSync(join(root, SIGNIN_TIMEOUT_FILE), { force: true });
  }
  catch (error) { if (error.code !== 'ENOENT') throw new BackendError('browserConfiguration'); }
}

export async function unlockSigninProfile(profileRoot, owner) {
  const root = resolve(profileRoot);
  const lock = await claimLocks.get(root);
  if (!lock || !lock.owners.has(owner)) return;
  lock.owners.delete(owner);
  if (lock.owners.size) return;
  claimLocks.delete(root);
  await new Promise((resolveClose, reject) => lock.close(error => error ? reject(new BackendError('browserConfiguration')) : resolveClose()));
}

async function reconcileSessionCookies(context, credential, origin) {
  if (typeof credential !== 'string' || /[\r\n\0]/.test(credential)) throw new BackendError('expired');
  const sessionName = new URL(origin).protocol === 'https:'
    ? /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/
    : /^(?:__Secure-|__Host-)?next-auth\.session-token(?:\.\d+)?$/;
  const desired = credential.split(';').map(pair => {
    const at = pair.indexOf('=');
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
  }).filter(cookie => sessionName.test(cookie.name));
  if (!desired.length || desired.some(cookie => !cookie.value)) throw new BackendError('expired');
  try {
    const current = (await context.cookies(String(origin))).filter(cookie => sessionName.test(cookie.name));
    if (current.length === desired.length && current.every(cookie => desired.some(next => next.name === cookie.name && next.value === cookie.value))) return;
    if (new URL(origin).protocol !== 'https:' && desired.some(cookie => /^(?:__Secure-|__Host-)/.test(cookie.name))) {
      console.error(JSON.stringify({ event: 'session-cookie-reconcile-skipped', origin: new URL(origin).origin }));
      return;
    }
    for (const cookie of current) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    await context.addCookies(desired.map(cookie => ({ ...cookie, url: new URL('/', origin).href, httpOnly: true, secure: new URL(origin).protocol === 'https:', sameSite: 'Lax' })));
  } catch { throw new BackendError('upstream'); }
}

export async function launchBrowserContext(profile, options) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new BackendError('browserDependency'); }
  if (!options.headless) return chromium.launchPersistentContext(profile, options);
  const probe = await chromium.launch({ channel: options.channel, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  let userAgent;
  try {
    const session = await probe.newBrowserCDPSession();
    userAgent = (await session.send('Browser.getVersion')).userAgent.replace('HeadlessChrome/', 'Chrome/');
  } finally { await probe.close(); }
  return chromium.launchPersistentContext(profile, { ...options, userAgent });
}

export class BrowserSupervisor {
  #accounts = new Map();
  #closed = false;
  constructor({ profileRoot, profile, launch, idleMilliseconds = 300_000, headless = true, channel = 'chrome' } = {}) {
    this.profileRoot = profileRoot;
    this.profile = profile;
    this.idleMilliseconds = idleMilliseconds;
    this.options = { headless, channel };
    this.launch = launch ?? (async (profile, options) => {
      return launchBrowserContext(profile, {
        ...options, offline: true, serviceWorkers: 'block',
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    });
  }
  async #ensure(account, headless) {
    if (this.#closed) throw new BackendError('browserClosed');
    if (typeof account !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(account)) throw new BackendError('browserConfiguration');
    if (this.profile !== undefined ? typeof this.profile !== 'string' || !this.profile : typeof this.profileRoot !== 'string' || !this.profileRoot) throw new BackendError('browserConfiguration');
    let entry = this.#accounts.get(account);
    if (entry && entry.headless !== headless) {
      if (entry.users) throw new Error('An active operation holds the browser context in the other mode. Wait for it to finish before switching modes.');
      await this.closeAccount(account);
      return this.#ensure(account, headless);
    }
    if (!entry) {
      entry = { users: 0, context: null, timer: null, crashed: new Set(), closed: false, stopping: false, headless };
      this.#accounts.set(account, entry);
      entry.starting = Promise.resolve().then(() => this.launch(this.profile ?? resolve(this.profileRoot, account), { ...this.options, headless })).then(async context => {
        entry.context = context;
        entry.closed = false;
        context.once('close', () => {
          entry.closed = true;
          clearTimeout(entry.timer);
          if (this.#accounts.get(account) === entry) this.#accounts.delete(account);
          for (const reject of entry.crashed) reject(new BackendError('browserClosed'));
        });
        try {
          for (const page of context.pages()) if (page.url() !== 'about:blank') await page.goto('about:blank');
        } catch {
          await context.close();
          throw new BackendError('browserProfile');
        }
        if (this.#closed) { await context.close(); throw new BackendError('browserClosed'); }
        return context;
      }).catch(error => {
        if (this.#accounts.get(account) === entry) this.#accounts.delete(account);
        throw error instanceof BackendError ? error : new BackendError('backendDown');
      });
    }
    clearTimeout(entry.timer);
    return entry;
  }
  async run(account, operation, signal, { visibleTurns, auth, origin = 'https://chatgpt.com' } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const entry = await this.#ensure(account, visibleTurns === undefined ? this.options.headless : !visibleTurns);
      entry.users++;
      let rejectCrash;
      let onAbort;
      try {
        const context = await entry.starting;
        signal?.throwIfAborted();
        if (entry.closed) throw new BackendError('browserClosed');
        return await Promise.race([
          new Promise((resolve, reject) => {
            rejectCrash = reject;
            entry.crashed.add(reject);
            onAbort = () => reject(signal.reason ?? new BackendError('upstream'));
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
          Promise.resolve().then(async () => {
            if (auth !== undefined) await reconcileSessionCookies(context, auth.refresh, origin);
            signal?.throwIfAborted();
            return operation(context, signal);
          }),
        ]);
      } catch (error) {
        if (attempt || !entry.closed || entry.stopping || this.#closed || signal?.aborted) throw error;
      } finally {
        entry.users--;
        entry.crashed.delete(rejectCrash);
        signal?.removeEventListener('abort', onAbort);
        if (!entry.users && this.#accounts.get(account) === entry && !this.#closed) {
          entry.timer = setTimeout(() => { this.closeAccount(account).catch(() => {}); }, this.idleMilliseconds);
        }
      }
    }
  }
  async closeAccount(account) {
    const entry = this.#accounts.get(account);
    if (!entry) return;
    entry.stopping = true;
    this.#accounts.delete(account);
    clearTimeout(entry.timer);
    const context = await entry.starting.catch(() => null);
    await context?.close();
  }
  async close() {
    this.#closed = true;
    await Promise.all([...this.#accounts.keys()].map(account => this.closeAccount(account)));
  }
}

export class LoginStates {
  #states = new Map();
  start(account) { this.#states.set(account, { state: 'pending' }); return this.status(account); }
  finish(account, state, credential, error) {
    if (state === 'signed-in') this.#states.set(account, { state, credential });
    else if (state === 'cancelled') this.#states.set(account, { state });
    else this.#states.set(account, { state: state === 'timeout' ? 'timeout' : 'failed', reason: error instanceof BackendError ? error.toJSON().message : error?.message || (typeof error === 'string' && error) || (state === 'timeout' ? new BackendError('signinTimeout', { values: { windowMinutes: signinTimeoutWindow() } }).message : 'Sign-in failed. Start sign-in again.') });
    return this.status(account);
  }
  status(account) { return structuredClone(this.#states.get(account) ?? { state: 'cancelled' }); }
  clear(account) { this.#states.delete(account); }
}

export function chromeArguments(profile, port, { proxy, env = process.env } = {}) {
  proxy ??= env.MAGPIE_HTTPS_PROXY || env.MAGPIE_HTTP_PROXY || env.MAGPIE_ALL_PROXY;
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check'];
  if (proxy) args.push(`--proxy-server=${proxy}`);
  return args;
}

class BrowserComponentError extends BackendError {
  constructor() {
    super('missingComponent');
    this.code = 'missingComponent';
    this.status = 503;
    this.component = 'Google Chrome';
    this.remedy = 'Install Google Chrome and retry sign-in.';
    this.message = `${this.component} was not found. ${this.remedy}`;
  }
  toJSON() { return { status: this.status, message: this.message }; }
}

export function sessionCredential(session, refresh, profile) {
  const expires = Date.parse(session?.expires);
  if (typeof session?.accessToken !== 'string' || !session.accessToken.trim() || !Number.isFinite(expires) || expires <= Date.now()) throw new BackendError('expired');
  return { type: 'oauth', refresh, access: session.accessToken, expires, accountId: typeof session.user?.email === 'string' ? session.user.email : 'chatgpt-web', profile, persona: 'chatgpt-paid' };
}

export async function launchSignInBrowser(profile, signal, { proxy, env = process.env, chromium, spawn: spawnBrowser = spawn, candidates } = {}) {
  if (!chromium) {
    try { ({ chromium } = await import('playwright-core')); }
    catch { throw new BackendError('browserDependency'); }
  }
  candidates ??= process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', resolve(process.env.LOCALAPPDATA ?? '.', 'Google/Chrome/Application/chrome.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  let executable;
  for (const candidate of candidates) {
    try { await access(candidate); executable = candidate; break; } catch {}
  }
  if (!executable) throw new BrowserComponentError();
  await mkdir(profile, { recursive: true });
  const listener = createServer();
  const port = await new Promise((resolvePort, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port;
      listener.close(error => error ? reject(error) : resolvePort(selected));
    });
  });
  signal?.throwIfAborted();
  const child = spawnBrowser(executable, chromeArguments(profile, port, { proxy, env }), { stdio: ['ignore', 'ignore', 'ignore'] });
  let ended = false;
  const exited = new Promise(resolveExit => {
    child.once('error', () => { ended = true; resolveExit(); });
    child.once('exit', () => { ended = true; resolveExit(); });
  });
  let browser;
  const close = async () => {
    if (browser?.isConnected()) {
      try { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch {}
    }
    if (!ended) {
      const timer = setTimeout(() => child.kill(), 3000);
      await exited;
      clearTimeout(timer);
    }
  };
  try {
    const until = Date.now() + 20000;
    while (!ended && Date.now() < until) {
      signal?.throwIfAborted();
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
      catch { await delay(100, undefined, { signal }); }
    }
    if (!browser) throw new BackendError('backendDown');
    const context = browser.contexts()[0];
    if (!context) throw new BackendError('backendDown');
    return { context, close };
  } catch (error) {
    await close();
    throw error instanceof BackendError ? error : new BackendError('backendDown');
  }
}

export async function browserRead(context, page, path, origin, signal) {
  const base = new URL(origin);
  if (!(base.origin === 'https://chatgpt.com' || (['http:', 'https:'].includes(base.protocol) && ['127.0.0.1', '[::1]'].includes(base.hostname))) || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw new BackendError('protocol');
  if (!['/api/auth/session', '/backend-api/models'].includes(path) || new URL(page.url()).origin !== base.origin) throw new BackendError('protocol');
  signal?.throwIfAborted();
  try {
    const result = await page.evaluate(async path => {
      const response = await fetch(path, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(20000) });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (response.status !== 200 && bytes > 65536) {
            body += decoder.decode(value.subarray(0, Math.max(0, 65536 - (bytes - value.byteLength))), { stream: true });
            break;
          }
          if (bytes > 4 * 1024 * 1024) throw new Error('response exceeds limit');
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) { if (response.status === 200) throw error; }
      finally { await reader.cancel().catch(() => {}); }
      return { status: response.status, headers: { 'cf-mitigated': response.headers.get('cf-mitigated'), 'content-type': response.headers.get('content-type'), 'retry-after': response.headers.get('retry-after') }, body };
    }, path);
    signal?.throwIfAborted();
    const failure = responseFailure(result.status, challengeEvidence(result.headers, result.body), undefined, result.headers['retry-after']);
    if (failure) throw failure;
    let value;
    try { value = JSON.parse(result.body); } catch { throw new BackendError('protocol'); }
    const cookies = path === '/api/auth/session' ? (await context.cookies(base.origin)).filter(cookie => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/.test(cookie.name)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
    if (path === '/api/auth/session' && (!cookies || typeof value?.accessToken !== 'string' || !value.accessToken.trim())) throw new BackendError('expired');
    return { value, cookies };
  } catch (error) { throw error instanceof BackendError ? error : new BackendError('upstream'); }
}

export function createLoginFlow({ launch = launchSignInBrowser, origin = 'https://chatgpt.com', pollMilliseconds = 2000,
  probeSignedIn = async page => {
    const button = page.getByRole('button', { name: /open profile menu|打开个人资料菜单|打开个人信息菜单/i });
    return await button.count() > 0 && await button.first().isVisible();
  },
} = {}) {
  return async (account, signal, profileRoot, { proxy } = {}) => {
    let owned;
    let closed = false;
    let closePromise;
    const close = () => closePromise ??= Promise.resolve().then(() => owned?.close());
    let interrupt;
    const interrupted = new Promise((resolve, reject) => { interrupt = reject; });
    interrupted.catch(() => {});
    const wait = work => Promise.race([interrupted, work]);
    const onClose = () => { closed = true; interrupt(new BackendError('browserClosed')); };
    const abort = () => { interrupt(signal.reason); close().catch(() => {}); };
    try {
      if (typeof account !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(account) || typeof profileRoot !== 'string' || !profileRoot) throw new BackendError('browserConfiguration');
      signal?.throwIfAborted();
      owned = await launch(resolve(profileRoot, account), signal, { proxy });
      const context = owned.context;
      context.once('close', onClose);
      signal?.addEventListener('abort', abort, { once: true });
      signal?.throwIfAborted();
      let page;
      try {
        for (const restored of context.pages()) if (restored.url() !== 'about:blank') await wait(restored.goto('about:blank'));
        page = context.pages()[0] ?? await wait(context.newPage());
        await wait(page.goto(origin));
      } catch (error) { throw new Error('The sign-in page could not be loaded. Check the network/proxy and retry sign-in.', { cause: error }); }
      while (!closed && !page.isClosed()) {
        signal?.throwIfAborted();
        if (await wait(probeSignedIn(page))) {
          const cookies = await wait(context.cookies(origin));
          if (cookies.some(cookie => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/.test(cookie.name))) {
            const result = await wait(browserRead(context, page, '/api/auth/session', origin, signal));
            signal?.throwIfAborted();
            if (closed || page.isClosed()) return { state: 'cancelled' };
            return { state: 'signed-in', credential: sessionCredential(result.value, result.cookies, account) };
          }
        }
        if (!closed && !page.isClosed()) await wait(delay(pollMilliseconds, undefined, { signal }));
      }
      signal?.throwIfAborted();
      return { state: 'cancelled' };
    } catch (error) {
      const cause = signal?.aborted ? signal.reason : error;
      if (cause?.code === 'signinTimeout') {
        return { state: 'timeout', reason: cause.message, error: cause };
      }
      if (signal?.aborted && cause?.name === 'AbortError') return { state: 'cancelled' };
      if (!signal?.aborted && (closed || owned?.context.pages().every(page => page.isClosed()))) return { state: 'cancelled' };
      return { state: 'failed', reason: cause instanceof BackendError ? cause.toJSON().message : cause?.message || 'Sign-in failed. Start sign-in again.', error: cause };
    } finally {
      signal?.removeEventListener('abort', abort);
      owned?.context.removeListener('close', onClose);
      await close();
    }
  };
}
