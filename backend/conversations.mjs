import { createHash } from 'node:crypto';
import { BackendError } from './guard.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Conversations {
  entries = new Map();
  constructor({ now = Date.now, idleMilliseconds = 1800000 } = {}) {
    this.now = now;
    this.idleMilliseconds = idleMilliseconds;
  }
  async take(request, account) {
    for (const [key, entry] of this.entries) if (!entry.busy && this.now() - entry.used >= this.idleMilliseconds) await this.discard(key);
    const key = request.conversationKey;
    let entry = key && this.entries.get(key);
    if (entry) {
      if (entry.account !== account || entry.busy || entry.model !== request.model || entry.system !== request.system) throw new BackendError('binding');
      if (entry.history && (request.history.length <= entry.history.length || digest(request.history.slice(0, entry.history.length)) !== entry.contextDigest)) throw new BackendError('binding');
      if (entry.page?.isClosed()) entry.page = undefined;
    } else {
      if (this.entries.size >= 64) {
        const victim = [...this.entries].filter(([, value]) => !value.busy).sort((left, right) => left[1].used - right[1].used)[0];
        if (!victim) throw new BackendError('capacity');
        await this.discard(victim[0]);
      }
      entry = { key, account, model: request.model, system: request.system, used: this.now() };
      if (key) this.entries.set(key, entry);
    }
    entry.used = this.now();
    return entry;
  }
  finish(entry, request, text) {
    entry.history = [...request.history, { role: 'assistant', content: text }];
    entry.contextDigest = digest(entry.history);
    entry.used = this.now();
    entry.busy = false;
  }
  async failed(entry) {
    await entry.page?.close().catch(() => {});
    entry.page = undefined;
    entry.conversationUrl = undefined;
    entry.busy = false;
    if (entry.key) this.entries.delete(entry.key);
  }
  async discard(key, account) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.busy || (account && entry.account !== account)) throw new BackendError('binding');
    await entry.page?.close().catch(() => {});
    this.entries.delete(key);
  }
  async close() {
    await Promise.all([...this.entries.values()].map(entry => this.failed(entry)));
  }
}
