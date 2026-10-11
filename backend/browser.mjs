import { resolve } from 'node:path';
import { BackendError } from './guard.mjs';

export class BrowserSupervisor {
  #accounts = new Map();
  #closed = false;
  constructor({ profileRoot, launch, idleMilliseconds = 900_000, headless = true, channel = 'chrome' } = {}) {
    this.profileRoot = profileRoot;
    this.idleMilliseconds = idleMilliseconds;
    this.options = { headless, channel };
    this.launch = launch ?? (async (profile, options) => {
      const { chromium } = await import('playwright-core');
      return chromium.launchPersistentContext(profile, {
        ...options, offline: true, serviceWorkers: 'block',
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    });
  }
  async #ensure(account) {
    if (this.#closed || !this.profileRoot || typeof account !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(account)) throw new BackendError('backendDown');
    let entry = this.#accounts.get(account);
    if (!entry) {
      entry = { users: 0, context: null, timer: null, crashed: new Set() };
      this.#accounts.set(account, entry);
      entry.starting = this.launch(resolve(this.profileRoot, account), this.options).then(async context => {
        entry.context = context;
        context.once('close', () => {
          clearTimeout(entry.timer);
          if (this.#accounts.get(account) === entry) this.#accounts.delete(account);
          for (const reject of entry.crashed) reject(new BackendError('backendDown'));
        });
        if (context.pages().some(page => page.url() !== 'about:blank')) {
          await context.close();
          throw new BackendError('protocol');
        }
        if (this.#closed) { await context.close(); throw new BackendError('backendDown'); }
        return context;
      }).catch(() => {
        if (this.#accounts.get(account) === entry) this.#accounts.delete(account);
        throw new BackendError('backendDown');
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
  finish(account, state, credential) {
    if (state === 'signed-in') this.#states.set(account, { state, credential });
    else if (state === 'cancelled') this.#states.set(account, { state });
    else this.#states.set(account, { state: 'failed', reason: new BackendError('backendDown').message });
    return this.status(account);
  }
  status(account) { return structuredClone(this.#states.get(account) ?? { state: 'cancelled' }); }
  clear(account) { this.#states.delete(account); }
}
