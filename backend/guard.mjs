import { setTimeout as delay } from 'node:timers/promises';

const definitions = Object.freeze({
  expired: [401, 'Sign in again to refresh the ChatGPT session.'],
  cooldown: [429, 'The account is cooling down after a rate limit.'],
  upstream: [502, 'The upstream request failed.'],
  empty: [502, 'ChatGPT returned an empty reply.'],
  protocol: [502, 'The backend or upstream protocol is invalid.'],
  verification: [502, 'Complete human verification in the sign-in browser.'],
  capacity: [503, 'Local backend capacity is exhausted; wait for active work or retained account restrictions to clear.'],
  browserDependency: [503, 'The playwright-core dependency is unavailable; install the packaged dependency.'],
  browserProfile: [502, 'The browser profile restored a page other than about:blank.'],
  browserConfiguration: [502, 'Browser account or profile root configuration is invalid.'],
  browserClosed: [503, 'The browser context closed or its supervisor stopped.'],
  backendDown: [503, 'Backend unavailable; install Node 20 or newer and Chrome or Edge.'],
});

export class BackendError extends Error {
  constructor(code = 'upstream', { retryAfter } = {}) {
    const kind = Object.hasOwn(definitions, code) ? code : 'upstream';
    super(definitions[kind][1]);
    this.name = 'BackendError';
    this.code = kind;
    this.status = definitions[kind][0];
    if (kind === 'expired') this.signIn = 'expired';
    if (kind === 'cooldown') this.retryAfter = String(Math.min(604800, Math.max(1, Math.ceil(Number(retryAfter) || 60))));
  }
  toJSON() {
    const clean = new BackendError(this.code, { retryAfter: this.retryAfter });
    return { status: clean.status, message: clean.message, ...(clean.retryAfter ? { retryAfter: clean.retryAfter } : {}), ...(clean.signIn ? { signIn: clean.signIn } : {}) };
  }
  get headers() {
    return { ...(this.signIn ? { 'x-magpie-sign-in': 'expired' } : {}), ...(this.retryAfter ? { 'retry-after': this.retryAfter } : {}) };
  }
  static fromEnvelope(envelope) {
    const known = Object.keys(definitions).find(key => definitions[key][0] === envelope?.status && definitions[key][1] === envelope?.message);
    const code = known ?? (envelope?.status === 401 ? 'expired' : envelope?.status === 429 ? 'cooldown' : envelope?.status === 503 ? 'backendDown' : 'protocol');
    return new BackendError(code, { retryAfter: envelope?.retryAfter });
  }
}

export function publicError(error) {
  return error instanceof BackendError ? error.toJSON() : new BackendError('upstream').toJSON();
}

export class AccountGuard {
  #tail = Promise.resolve();
  #next = 0;
  #until = 0;
  #blocked = false;
  constructor({ now = Date.now, sleep = (milliseconds, signal) => delay(milliseconds, undefined, { signal }) } = {}) {
    this.now = now;
    this.sleep = sleep;
  }
  restriction() {
    if (this.#blocked) throw new BackendError('expired');
    if (this.#until > this.now()) throw new BackendError('cooldown', { retryAfter: (this.#until - this.now()) / 1000 });
  }
  async begin(signal) {
    signal?.throwIfAborted();
    this.restriction();
    const previous = this.#tail;
    let unlock;
    this.#tail = new Promise(resolve => { unlock = resolve; });
    let onAbort;
    try {
      await Promise.race([previous, new Promise((resolve, reject) => {
        onAbort = () => reject(new BackendError('upstream'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      })]);
      signal?.throwIfAborted();
      this.restriction();
      const wait = this.#next - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      signal?.throwIfAborted();
      this.restriction();
    } catch (error) {
      previous.finally(unlock);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#next = this.now() + 1000;
      unlock();
    };
  }
  observe(status, retryAfter) {
    if (status === 401 || status === 403) this.#blocked = true;
    if (status !== 429) return;
    const value = String(retryAfter ?? '').trim();
    let seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - this.now()) / 1000;
    if (!Number.isFinite(seconds)) seconds = 60;
    seconds = Math.min(604800, Math.max(1, seconds));
    this.#until = this.now() + seconds * 1000;
    return String(Math.ceil((this.#until - this.now()) / 1000));
  }
}
