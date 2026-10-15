import { setTimeout as delay } from 'node:timers/promises';

// Error taxonomy (codes, statuses, message templates) duplicated from
// src/errors.mjs, which is the canonical source. Parity between the two tables
// is locked by test/errors-parity.test.mjs. Codes with {slots} in their
// template require a `values` object at construction; the envelope carries the
// code and values so the parameterized message survives the bridge round trip.

const definitions = Object.freeze({
  expired: [401, 'Sign in again to refresh the ChatGPT session.'],
  cooldown: [429, 'The account is cooling down after a rate limit.'],
  upstream: [502, 'The upstream request failed.'],
  requestBudget: [504, 'This request exceeded its local time budget and was stopped before any confirmed result.'],
  empty: [502, 'ChatGPT returned an empty reply.'],
  hidden: [502, 'ChatGPT hid the reply from the conversation.'],
  truncated: [502, 'ChatGPT stopped before confirming the reply was complete.'],
  unsupported: [400, 'This provider accepts text and client tool blocks; attachments and other content blocks are unavailable.'],
  invalidRequest: [400, 'The request is invalid.'],
  toolDefinition: [400, 'The tool definitions are invalid or use unsupported schema keywords.'],
  toolChoice: [400, 'The tool choice is invalid or names an undefined tool.'],
  toolUnknown: [502, 'ChatGPT requested an undefined tool.'],
  toolJSON: [502, 'ChatGPT returned malformed tool-call JSON.'],
  toolSchema: [502, 'ChatGPT tool arguments do not match the input schema.'],
  toolChoiceViolation: [502, 'ChatGPT did not follow the requested tool choice.'],
  toolParallel: [502, 'ChatGPT emitted multiple tool calls when parallel calls were disabled.'],
  toolIncomplete: [502, 'ChatGPT ended the reply inside an incomplete tool call.'],
  toolRequired: [502, 'ChatGPT did not produce the required tool call.'],
  toolDelimiter: [502, 'ChatGPT returned a malformed tool-call delimiter.'],
  toolLimit: [502, 'The tool call or schema validation exceeded its complexity limit.'],
  binding: [409, 'The conversation belongs to another account or its history was replayed or changed.'],
  temporary: [502, 'Temporary chat could not be confirmed; no message was sent.'],
  pageShape: [502, 'The ChatGPT page or model picker changed; update the plugin.'],
  harvest: [502, 'The answer reader failed; no completed reply can be confirmed.'],
  protocol: [502, 'The backend or upstream protocol is invalid.'],
  verification: [502, 'ChatGPT asked to verify you are human. Complete verification in the open browser, then retry the chat.'],
  capacity: [503, 'Local backend capacity is exhausted; active work and cooldowns may clear, but sign-in blocks persist until the backend restarts.'],
  browserDependency: [503, 'The playwright-core dependency is unavailable; install the packaged dependency.'],
  browserProfile: [502, 'The browser profile restored a page other than about:blank.'],
  browserConfiguration: [502, 'Browser account or profile root configuration is invalid.'],
  browserClosed: [503, 'The browser context closed or its supervisor stopped.'],
  backendDown: [503, 'Backend unavailable; install Node 20 or newer and Chrome.'],
  signinTimeout: [504, 'Sign-in did not finish within {windowMinutes} minutes. Start sign-in again; the previous attempt was cancelled cleanly.'],
  missingComponent: [503, '{component} was not found. {remedy}'],
  pickerMissing: [502, 'The ChatGPT page changed: {component} was not found (selector {selector}, adapter {adapterVersion}). Update the plugin; if it is already latest, report this adapter version.'],
  pickerAmbiguous: [502, "The model picker shows {count} entries for {slug}; the plugin cannot choose safely. Retry, or select the model once by hand in a visible browser (enable 'visible-turns')."],
  modelNotOffered: [400, '{slug} is not offered to this ChatGPT account. Pick one of the listed models; refresh the model list if the account changed.'],
  attachmentUnsupported: [400, 'This message contains {kind}, which chatgpt-web cannot send. Remove it and retry. Images are supported up to {maxCount} files / {maxBytes} each.'],
  imageRejected: [502, 'ChatGPT refused the image upload ({detail}). Retry; if it persists, send the message without the image.'],
});

export const errorTable = definitions;

function renderMessage(template, values) {
  return values ? template.replace(/\{(\w+)\}/g, (slot, key) => (Object.hasOwn(values, key) ? values[key] : slot)) : template;
}

function slotValues(code) {
  const slots = definitions[code][1].match(/\{(\w+)\}/g);
  return slots ? [...new Set(slots.map(slot => slot.slice(1, -1)))] : [];
}

export class BackendError extends Error {
  #values;
  constructor(code = 'upstream', { retryAfter, values } = {}) {
    const kind = Object.hasOwn(definitions, code) ? code : 'upstream';
    const slots = slotValues(kind);
    let stored;
    if (slots.length) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError(`BackendError('${code}') requires a values object with: ${slots.join(', ')}`);
      stored = {};
      for (const slot of slots) {
        if (values[slot] === undefined || values[slot] === null) throw new TypeError(`BackendError('${code}') requires values.${slot}`);
        stored[slot] = String(values[slot]);
      }
    }
    super(renderMessage(definitions[kind][1], stored));
    this.name = 'BackendError';
    this.code = kind;
    this.status = definitions[kind][0];
    this.#values = stored && Object.freeze(stored);
    if (kind === 'expired') this.signIn = 'expired';
    if (kind === 'cooldown') this.retryAfter = String(Math.min(604800, Math.max(1, Math.ceil(Number(retryAfter) || 60))));
  }
  toJSON() {
    const clean = new BackendError(this.code, { retryAfter: this.retryAfter, values: this.#values });
    return {
      status: clean.status,
      message: clean.message,
      ...(clean.#values ? { code: this.code, values: { ...clean.#values } } : {}),
      ...(clean.retryAfter ? { retryAfter: clean.retryAfter } : {}),
      ...(clean.signIn ? { signIn: clean.signIn } : {}),
    };
  }
  get headers() {
    const clean = this.toJSON();
    return { ...(clean.signIn ? { 'x-magpie-sign-in': clean.signIn } : {}), ...(clean.retryAfter ? { 'retry-after': clean.retryAfter } : {}) };
  }
  static fromEnvelope(envelope) {
    if (typeof envelope?.code === 'string' && Object.hasOwn(definitions, envelope.code) && envelope.values && typeof envelope.values === 'object' && !Array.isArray(envelope.values)) {
      try {
        return new BackendError(envelope.code, { retryAfter: envelope.retryAfter, values: envelope.values });
      } catch { /* fall through to the template-match path */ }
    }
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
