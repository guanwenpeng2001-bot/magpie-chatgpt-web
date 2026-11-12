import { createHash } from 'node:crypto';
import { BackendError } from './guard.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fingerprint(request) {
  return {
    toolsDigest: digest(request.tools ?? []),
    choiceDigest: digest(request.toolChoice ?? request.choice ?? { type: 'auto' }),
    imageSignatures: (request.images ?? []).map(image => digest(image)),
  };
}
export class Conversations {
  entries = new Map();
  constructor({ now = Date.now, idleMilliseconds = 1800000 } = {}) {
    this.now = now;
    this.idleMilliseconds = idleMilliseconds;
  }
  async take(request, account) {
    const closing = [];
    for (const [key, entry] of this.entries) if (!entry.busy && this.now() - entry.used >= this.idleMilliseconds) closing.push(this.discard(key).catch(() => {}));
    const key = request.conversationKey;
    let entry = key && this.entries.get(key);
    if (entry) {
      if (entry.account !== account || entry.busy || entry.model !== request.model || entry.system !== request.system) throw new BackendError('binding');
      const current = fingerprint(request);
      const pending = Boolean(entry.pendingChallenge);
      const imagesMatch = pending || !entry.history
        ? current.imageSignatures.length === entry.fingerprint.imageSignatures.length &&
          current.imageSignatures.every((value, index) => value === entry.fingerprint.imageSignatures[index])
        : current.imageSignatures.length >= entry.fingerprint.imageSignatures.length &&
          entry.fingerprint.imageSignatures.every((value, index) => value === current.imageSignatures[index]);
      const shapeMismatch = current.toolsDigest !== entry.fingerprint.toolsDigest ||
        current.choiceDigest !== entry.fingerprint.choiceDigest || !imagesMatch;
      const pendingMismatch = pending && digest(request.history) !== entry.pendingChallenge.historyDigest;
      if (pendingMismatch || shapeMismatch ||
          entry.history && (request.history.length <= entry.resumeIndex || digest(request.history.slice(0, entry.resumeIndex)) !== entry.contextDigest)) {
        closing.push(this.discard(key).catch(() => {}));
        entry = undefined;
      }
    }
    if (!entry) {
      if (key && this.entries.size >= 64) {
        const victim = [...this.entries].filter(([, value]) => !value.busy).sort((left, right) => left[1].used - right[1].used)[0];
        if (!victim) throw new BackendError('capacity');
        closing.push(this.discard(victim[0]).catch(() => {}));
      }
      entry = {
        key,
        account,
        model: request.model,
        system: request.system,
        fingerprint: fingerprint(request),
        used: this.now(),
        resumeIndex: 0,
      };
      // Preserve direct-entry callers while supporting the new destructuring seam.
      Object.defineProperty(entry, 'entry', { get() { return this; } });
      if (key) this.entries.set(key, entry);
    }
    if (entry.page?.isClosed()) entry.page = undefined;
    if (!entry.page) entry.resumeIndex = 0;
    entry.resumeFrom = entry.resumeIndex;
    entry.used = this.now();
    entry.busy = true;
    await Promise.all(closing);
    return entry;
  }
  finish(entry, request, text, assistantContent = text) {
    entry.history = structuredClone([...request.history, { role: 'assistant', content: assistantContent }]);
    entry.contextDigest = digest(entry.history);
    entry.resumeIndex = entry.history.length;
    entry.used = this.now();
    entry.busy = false;
  }
  async failed(entry) {
    if (entry.key && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const page = entry.page;
    entry.page = undefined;
    entry.busy = false;
    await page?.close().catch(() => {});
  }
  async discard(key, account) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.busy || (account && entry.account !== account)) throw new BackendError('binding');
    await this.failed(entry);
  }
  async close() {
    await Promise.all([...this.entries.values()].map(entry => this.failed(entry)));
  }
}
