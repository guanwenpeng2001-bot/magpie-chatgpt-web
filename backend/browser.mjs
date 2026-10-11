import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { challengeEvidence, responseFailure } from './http.mjs';
import { BackendError } from './guard.mjs';

export class BrowserSupervisor {
  #accounts = new Map();
  #closed = false;
  constructor({ profileRoot, launch, idleMilliseconds = 900_000, headless = true, channel = 'chrome' } = {}) {
    this.profileRoot = profileRoot;
    this.idleMilliseconds = idleMilliseconds;
    this.options = { headless, channel };
    this.launch = launch ?? (async (profile, options) => {
      let chromium;
      try { ({ chromium } = await import('playwright-core')); }
      catch { throw new BackendError('browserDependency'); }
      return chromium.launchPersistentContext(profile, {
        ...options, offline: true, serviceWorkers: 'block',
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    });
  }
  async #ensure(account) {
    if (this.#closed) throw new BackendError('browserClosed');
    if (typeof this.profileRoot !== 'string' || !this.profileRoot || typeof account !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(account)) throw new BackendError('browserConfiguration');
    let entry = this.#accounts.get(account);
    if (!entry) {
      entry = { users: 0, context: null, timer: null, crashed: new Set() };
      this.#accounts.set(account, entry);
      entry.starting = this.launch(resolve(this.profileRoot, account), this.options).then(async context => {
        entry.context = context;
        context.once('close', () => {
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
  async run(account, operation, signal) {
    signal?.throwIfAborted();
    const entry = await this.#ensure(account);
    entry.users++;
    let rejectCrash;
    let onAbort;
    try {
      const context = await entry.starting;
      signal?.throwIfAborted();
      return await Promise.race([
        new Promise((resolve, reject) => {
          rejectCrash = reject;
          entry.crashed.add(reject);
          onAbort = () => reject(new BackendError('upstream'));
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
        Promise.resolve().then(() => operation(context, signal)),
      ]);
    } finally {
      entry.users--;
      entry.crashed.delete(rejectCrash);
      signal?.removeEventListener('abort', onAbort);
      if (!entry.users && this.#accounts.get(account) === entry && !this.#closed) {
        entry.timer = setTimeout(() => { this.closeAccount(account).catch(() => {}); }, this.idleMilliseconds);
      }
    }
  }
  async closeAccount(account) {
    const entry = this.#accounts.get(account);
    if (!entry) return;
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
    else this.#states.set(account, { state: 'failed', reason: error instanceof BackendError ? error.toJSON().message : new BackendError('backendDown').message });
    return this.status(account);
  }
  status(account) { return structuredClone(this.#states.get(account) ?? { state: 'cancelled' }); }
  clear(account) { this.#states.delete(account); }
}

export function chromeArguments(profile, port) {
  return [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check'];
}

export function sessionCredential(session, refresh, profile) {
  const expires = Date.parse(session?.expires);
  if (typeof session?.accessToken !== 'string' || !session.accessToken.trim() || !Number.isFinite(expires) || expires <= Date.now()) throw new BackendError('expired');
  return { type: 'oauth', refresh, access: session.accessToken, expires, accountId: typeof session.user?.email === 'string' ? session.user.email : 'chatgpt-web', profile, persona: 'chatgpt-paid' };
}

export async function launchSignInBrowser(profile, signal) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new BackendError('browserDependency'); }
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', resolve(process.env.LOCALAPPDATA ?? '.', 'Google/Chrome/Application/chrome.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  let executable;
  for (const candidate of candidates) {
    try { await access(candidate); executable = candidate; break; } catch {}
  }
  if (!executable) throw new BackendError('backendDown');
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
  const child = spawn(executable, chromeArguments(profile, port), { stdio: ['ignore', 'ignore', 'ignore'] });
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

export function createLoginFlow({ launch = launchSignInBrowser, origin = 'https://chatgpt.com', pollMilliseconds = 2000 } = {}) {
  return async (account, signal, profileRoot) => {
    if (typeof profileRoot !== 'string' || !profileRoot) throw new BackendError('browserConfiguration');
    const owned = await launch(resolve(profileRoot, account), signal);
    const context = owned.context;
    let closed = false;
    context.once('close', () => { closed = true; });
    const abort = () => { owned.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      for (const restored of context.pages()) if (restored.url() !== 'about:blank') await restored.goto('about:blank');
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(origin);
      while (!signal.aborted && !closed && !page.isClosed()) {
        const profileButton = page.getByRole('button', { name: /open profile menu|打开个人资料菜单|打开个人信息菜单/i });
        if (await profileButton.count() && await profileButton.first().isVisible()) {
          const cookies = await context.cookies(origin);
          if (cookies.some(cookie => /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(cookie.name))) {
            const result = await browserRead(context, page, '/api/auth/session', origin, signal);
            return { state: 'signed-in', credential: sessionCredential(result.value, result.cookies, account) };
          }
        }
        await delay(pollMilliseconds, undefined, { signal });
      }
      return { state: 'cancelled' };
    } catch (error) {
      if (closed || context.pages().every(page => page.isClosed())) return { state: 'cancelled' };
      throw error instanceof BackendError ? error : new BackendError('upstream');
    } finally {
      signal.removeEventListener('abort', abort);
      await owned.close();
    }
  };
}
