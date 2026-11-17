const HASH = /^[a-f0-9]{64}$/;
const unavailableByDefault = () => Object.assign(new Error('Retained compaction source unavailable.'), {
  code: 'compaction_source_unavailable',
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

/** Process-local ownership of exact managed Page handles, never URL discovery.
 * A failed close leaves a retired entry until release()/close() retries it.
 */
export class NativeRetainedPages {
  #entries = new Map();
  #admissions = new Map();
  #closed = false;
  #closing;
  #maxPages;
  #idleMs;
  #now;
  #unavailable;

  constructor({ maxPages = 8, idleMs = 300_000, now = Date.now, unavailable = unavailableByDefault } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isFinite(idleMs) || idleMs < 0
      || typeof now !== 'function' || typeof unavailable !== 'function') {
      throw new TypeError('Invalid retained-page registry options.');
    }
    this.#maxPages = maxPages;
    this.#idleMs = idleMs;
    this.#now = now;
    this.#unavailable = unavailable;
  }

  #validateKey(key) {
    if (typeof key !== 'string' || !HASH.test(key)) throw this.#unavailable();
  }

  #checkAdmission(ticket, signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (this.#closed || ticket?.retired) throw this.#unavailable();
  }

  #reusable(entry, appName, canResume) {
    try {
      return canResume === true && entry.appName === appName && entry.connectorBound
        && !entry.stale && this.#now() - entry.idleAt < this.#idleMs
        && entry.page && !entry.page.isClosed() && entry.page.url() === entry.url;
    } catch { return false; }
  }

  async acquire({ key, identity, requireRetained = false, canResume = false, signal } = {}) {
    this.#validateKey(key);
    const appName = identity?.appName;
    if (typeof appName !== 'string' || !appName.trim()) throw this.#unavailable();
    this.#checkAdmission(null, signal);
    const existing = this.#entries.get(key);
    // Check before any await: even a lazy reservation or retiring owner conflicts.
    if (this.#admissions.has(key) || existing?.active || existing?.retired) throw this.#unavailable();
    if (!existing && requireRetained) throw this.#unavailable();
    const ticket = { retired: false, done: deferred() };
    this.#admissions.set(key, ticket);
    try {
      if (existing) {
        if (this.#reusable(existing, appName, canResume)) return this.#lease(existing, true, signal);
        existing.retired = true;
        await this.#dispose(existing);
        this.#checkAdmission(ticket, signal);
        if (requireRetained) throw this.#unavailable();
      }

      // Lazy TTL pruning. Reservations and active/retiring owners are never evicted.
      const expired = [];
      for (const entry of this.#entries.values()) {
        if (!entry.active && !entry.retired && !this.#admissions.has(entry.key)
          && this.#now() - entry.idleAt >= this.#idleMs) {
          entry.retired = true;
          expired.push(this.#dispose(entry));
        }
      }
      if (expired.length) {
        await this.#settle(expired);
        this.#checkAdmission(ticket, signal);
      }
      while (this.#entries.size >= this.#maxPages) {
        const candidate = [...this.#entries.values()]
          .filter(entry => !entry.active && !entry.retired && !this.#admissions.has(entry.key))
          .sort((a, b) => a.idleAt - b.idleAt)[0];
        if (!candidate) throw this.#unavailable();
        candidate.retired = true;
        await this.#dispose(candidate);
        this.#checkAdmission(ticket, signal);
      }
      this.#checkAdmission(ticket, signal);
      const entry = { key, appName, retired: false, stale: false, connectorBound: false };
      this.#entries.set(key, entry);
      return this.#lease(entry, false, signal);
    } finally {
      this.#admissions.delete(key);
      ticket.done.resolve();
    }
  }

  #lease(entry, reused, signal) {
    const owner = { done: deferred(), signals: new Map(), finishing: false, aborted: false,
      delivered: reused, reused, url: entry.url, controller: new AbortController() };
    entry.active = owner;
    owner.abort = reason => {
      if (!owner.aborted) owner.abortReason = reason;
      owner.aborted = true;
      entry.retired = true;
      // Cancellation notifies the worker; only finish releases a delivered owner.
      owner.controller.abort(owner.abortReason);
    };
    const watch = nextSignal => {
      if (!nextSignal || owner.signals.has(nextSignal)) return;
      const abort = () => owner.abort(nextSignal.reason ?? new DOMException('Aborted', 'AbortError'));
      owner.signals.set(nextSignal, abort);
      nextSignal.addEventListener('abort', abort, { once: true });
      if (nextSignal.aborted) abort();
    };
    watch(signal);

    // Deliberately not an async function: repeated calls return the SAME promise.
    const finish = ({ completed = false, retain = false, connectorBound = false } = {}) => {
      if (owner.finishPromise) return owner.finishPromise;
      owner.finishing = true;
      owner.finishPromise = Promise.resolve().then(async () => {
        try {
          // Creation errors belong to page(); cleanup errors always escape finish().
          if (owner.creation) await owner.creation.catch(() => { entry.retired = true; });
          let keep = completed === true && retain === true && connectorBound === true
            && !entry.retired && !entry.stale && !this.#closed && !owner.aborted
            && owner.delivered === true && !!entry.page;
          if (keep) {
            try {
              keep = !entry.page.isClosed();
              const url = entry.page.url();
              if (owner.reused && url !== owner.url) {
                this.#markStale(entry);
                keep = false;
              }
              entry.url = url;
              entry.idleAt = this.#now();
            } catch { keep = false; }
          }
          if (keep) entry.connectorBound = true;
          else {
            entry.retired = true;
            await this.#dispose(entry);
          }
        } finally {
          entry.active = null;
          for (const [watched, listener] of owner.signals) watched.removeEventListener('abort', listener);
          owner.signals.clear();
        }
      });
      // Completion is a settlement barrier, including failed physical cleanup.
      owner.finishPromise.then(() => owner.done.resolve({ failed: false }),
        error => owner.done.resolve({ failed: true, error }));
      return owner.finishPromise;
    };

    const page = async (createPage, pageSignal) => {
      if (entry.active !== owner || owner.finishing) throw this.#unavailable();
      watch(pageSignal);
      try {
        if (owner.aborted) throw owner.abortReason;
        if (entry.retired || this.#closed) throw this.#unavailable();
        if (!entry.page && !owner.creation) {
          if (typeof createPage !== 'function') throw new TypeError('createPage must be a function.');
          owner.creation = Promise.resolve().then(async () => {
            // Abort before invocation creates no page. Once invoked, own even a late result.
            if (owner.aborted) throw owner.abortReason;
            if (entry.retired || this.#closed) throw this.#unavailable();
            const created = await createPage(pageSignal ?? signal);
            entry.page = created;
            if (!created || typeof created.close !== 'function' || typeof created.isClosed !== 'function'
              || typeof created.url !== 'function' || typeof created.mainFrame !== 'function'
              || typeof created.on !== 'function' || typeof created.off !== 'function') {
              throw this.#unavailable();
            }
            entry.navigation = frame => {
              if (entry.active && !entry.active.reused) return;
              try { if (frame !== created.mainFrame()) return; }
              catch { /* An unreadable frame cannot establish source continuity. */ }
              this.#markStale(entry);
            };
            created.on('framenavigated', entry.navigation);
            return created;
          });
        }
        if (owner.creation) await owner.creation;
        if (owner.aborted) throw owner.abortReason;
        if (entry.stale || (owner.reused && entry.page.url() !== owner.url)) {
          this.#markStale(entry);
          throw owner.abortReason ?? this.#unavailable();
        }
        if (entry.active !== owner || entry.retired || this.#closed || owner.finishing || entry.page.isClosed()) {
          throw this.#unavailable();
        }
        owner.delivered = true;
        return entry.page;
      } catch (error) {
        if (entry.active === owner) entry.retired = true;
        // An undelivered late creation still needs automatic cleanup. A delivered
        // owner (including a reused page) remains reserved until its worker finishes.
        if (!owner.delivered) await finish();
        throw error;
      }
    };
    return Object.freeze({ reused, signal: owner.controller.signal, page, finish });
  }

  #markStale(entry) {
    entry.stale = true;
    if (entry.active?.reused) entry.active.abort(this.#unavailable());
  }

  #dispose(entry) {
    if (entry.closing) return entry.closing;
    entry.closing = Promise.resolve().then(async () => {
      if (entry.page) {
        if (typeof entry.page.isClosed !== 'function' || !entry.page.isClosed()) await entry.page.close();
        if (typeof entry.page.isClosed === 'function' && !entry.page.isClosed()) throw this.#unavailable();
        if (entry.navigation) entry.page.off('framenavigated', entry.navigation);
      }
      if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    }).finally(() => { entry.closing = null; });
    return entry.closing;
  }

  async release(key) {
    this.#validateKey(key);
    const ticket = this.#admissions.get(key);
    if (ticket) ticket.retired = true;
    const entry = this.#entries.get(key);
    if (entry) entry.retired = true;
    const tasks = [];
    if (ticket) tasks.push(ticket.done.promise);
    if (entry) tasks.push((async () => {
      if (entry.active) {
        const outcome = await entry.active.done.promise;
        if (outcome.failed) throw outcome.error;
      }
      if (this.#entries.get(key) === entry) await this.#dispose(entry);
    })());
    await this.#settle(tasks);
  }

  async #settle(tasks) {
    const outcomes = await Promise.allSettled(tasks);
    const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Retained-page cleanup failed.');
  }

  close() {
    this.#closed = true;
    if (this.#closing) return this.#closing;
    const keys = new Set([...this.#entries.keys(), ...this.#admissions.keys()]);
    this.#closing = this.#settle([...keys].map(key => this.release(key)))
      .finally(() => { this.#closing = null; });
    return this.#closing;
  }
}
