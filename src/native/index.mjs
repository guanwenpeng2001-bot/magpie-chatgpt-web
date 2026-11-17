import { join, resolve } from 'node:path';
import { ensureRuntime, nativeRoot } from './runtime.mjs';
import { NativeDaemon, writePrivate, daemonProxy } from './daemon.mjs';
import { exportStorageState, findChromeExecutable, browserEndpoint } from '../../backend/browser.mjs';
import { nativeCatalog, describeNativeCatalogue, nativeOptions, providerNativeOptions, accountCapabilities } from './models.mjs';
import { readSetupStatus, readNativeState } from './setup.mjs';
import { BackendError } from '../../backend/guard.mjs';
import { browserProfileOf } from '../../backend/browser-profile.mjs';
import { preserveNativeVerification } from './response-errors.mjs';
import { continuityProfiles } from './continuity-profiles.mjs';

const accounts = new Map();
const pending = new Map();
function identity(account, root) {
  const profile = account.profile ?? account.profileId;
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid native account profile');
  return { profile, home: join(resolve(root), 'accounts', profile) };
}

/** provision(context, options) is injectable; the backend owns that context. */
export function ensureNative(account, options = {}) {
  const { root = nativeRoot() } = options;
  const { profile, home } = identity(account, root);
  const key = JSON.stringify([browserProfileOf({ ...account, profile }), options.catalogOnly === true,
    options.resumeOnly === true, options.nativeOptions, account.capabilities, options.continuityPeers]);
  const prior = pending.get(home);
  if (prior?.key === key) return prior.work;
  const work = (async () => {
    await prior?.work.catch(() => {});
    options.signal?.throwIfAborted();
    const saved = await readNativeState({ profile }, { root });
    if (!saved && (options.resumeOnly || options.catalogOnly)) return null;
    const existing = accounts.get(home);
    const settings = nativeOptions(options.nativeOptions ?? saved?.nativeOptions);
    const capabilities = account.capabilities ?? saved?.capabilities ?? {};
    if (saved) await writePrivate(join(home, 'native.json'), JSON.stringify({ ...saved, capabilities, nativeOptions: settings }));
    // Queue settings on the owner; never terminate a live generation to change
    // options. Its descriptor continues to advertise the effective generation.
    existing?.configure?.(settings, capabilities);
    if (options.catalogOnly) return { capabilities: (existing?.config ? existing.descriptor().capabilities : undefined) ?? { ...capabilities, ...settings } };
    if (existing && options.continuityPeers) await existing.configureContinuity?.(options.continuityPeers);
    const endpoint = browserEndpoint(account.context);
    if (existing && !options.provision && existing.browserEndpoint === endpoint && await existing.health()) return existing;
    if (existing) { await existing.stop(); accounts.delete(home); }
    options.onStage?.('install');
    const installed = await (options.install ?? ensureRuntime)({ root });
    options.signal?.throwIfAborted();
    options.onStage?.('startup');
    // Snapshot while the backend holds its BrowserContext lease; crash restarts
    // must not attempt to use a context that the idle browser pool has closed.
    const storage = await exportStorageState(account.context);
    const daemon = (options.createDaemon ?? (settings => new NativeDaemon(settings)))({ home, ...installed,
      appName: `Codex Magpie ${profile.slice(0, 8)}`,
      browserEndpoint: endpoint,
      chromeExecutablePath: account.chromeExecutablePath ?? await findChromeExecutable(), capabilities, nativeOptions: settings,
      continuityPeers: options.continuityPeers, storageState: async () => storage });
    // A failed startup may still own a live OS lease until cleanup succeeds.
    // Retain it so the next attempt and shutdown can retry that cleanup.
    accounts.set(home, daemon);
    const abort = () => { void daemon.stop().catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      let result = saved;
      if (!saved || options.provision) {
        options.onStage?.('verify');
        const provision = options.provision ?? (async (context, settings) => {
          const module = await import('./provision.mjs');
          return module.provision({ context, ...settings });
        });
        result = await provision(account.context, { profileId: profile, stateFile: join(home, 'provision.json'), signal: options.signal,
          saveSecret: bytes => writePrivate(join(home, 'runtime.key'), bytes),
          ensureTunnelRunning: credentials => { options.signal?.throwIfAborted(); return daemon.start(credentials); } });
      }
      options.signal?.throwIfAborted();
      options.onStage?.('startup');
      await daemon.start(result);
      options.signal?.throwIfAborted();
      await writePrivate(join(home, 'native.json'), JSON.stringify({ ...result, profile, capabilities, nativeOptions: settings }));
      accounts.set(home, daemon);
      return daemon;
    } catch (error) {
      try {
        await daemon.stop();
        if (accounts.get(home) === daemon) accounts.delete(home);
      } catch { /* keep the owner reachable for a later cleanup retry */ }
      throw error;
    }
    finally { options.signal?.removeEventListener('abort', abort); }
  })().finally(() => { if (pending.get(home)?.work === work) pending.delete(home); });
  pending.set(home, { key, work });
  return work;
}

export async function hasNative(account, root = nativeRoot()) {
  const { profile } = identity(account, root);
  return !!await readNativeState({ profile }, { root });
}

export async function stopNative() {
  await Promise.allSettled([...pending.values()].map(entry => entry.work));
  await Promise.allSettled([...accounts.entries()].map(async ([home, daemon]) => {
    await daemon.stop();
    if (accounts.get(home) === daemon) accounts.delete(home);
  }));
}

const securityCheck = error => error?.code === 'chatgpt_security_check' && error.type === 'permission_error';

async function verificationResponse(response, reveal, signal) {
  response = await preserveNativeVerification(response, signal);
  if (response.status === 403 && response.body && /application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
    // Inspect only a bounded copy of an error. Never consume the caller's body,
    // and do not let a broken error stream delay its original refusal forever.
    const reader = response.clone().body.getReader();
    const inspection = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
    const cancel = () => { void reader.cancel().catch(() => {}); };
    inspection.addEventListener('abort', cancel, { once: true });
    let text = '', bytes = 0, complete = false, verification = false;
    const decoder = new TextDecoder();
    try {
      while (!inspection.aborted) {
        const next = await reader.read();
        if (next.done) { complete = true; break; }
        bytes += next.value.byteLength;
        if (bytes > 65536) break;
        text += decoder.decode(next.value, { stream: true });
      }
      verification = complete && !inspection.aborted && securityCheck(JSON.parse(text + decoder.decode())?.error);
      if (verification) await reveal();
    } catch { /* Inspection/presentation cannot replace the original refusal. */ }
    finally {
      inspection.removeEventListener('abort', cancel);
      // Awaiting cancellation of a tee would wait for the caller to drain it.
      cancel();
      reader.releaseLock();
    }
    if (!verification) return response;
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-magpie-sign-in', 'kept');
    headers.set('x-should-retry', 'false');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;

  // A check can also arrive after output. Observe typed failure events without
  // changing those bytes/status or replaying the already submitted turn.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', skipping = false, notified = false, stopped = false;
  const scan = bytes => {
    let found = false;
    for (let offset = 0; offset < bytes.length && !notified; offset += 8192) {
      buffer += decoder.decode(bytes.subarray(offset, offset + 8192), { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (!skipping && frame.length <= 65536) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          try {
            const event = JSON.parse(data);
            if (event?.type === 'response.failed' && securityCheck(event.response?.error)) {
              notified = true;
              found = true;
            }
          } catch { /* Malformed/ordinary model text is never verification. */ }
        }
        skipping = false;
      }
      if (buffer.length > 65536) { skipping = true; buffer = buffer.slice(-3); }
    }
    return found;
  };
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const finish = () => { stopped = true; signal?.removeEventListener('abort', abort); reader.releaseLock(); };
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (stopped) return;
        signal?.throwIfAborted();
        if (next.done) { finish(); controller.close(); return; }
        if (scan(next.value)) await reveal();
        if (!stopped) controller.enqueue(next.value);
      } catch (error) {
        if (!stopped) { await reader.cancel(error).catch(() => {}); finish(); controller.error(error); }
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Plugin-side facade: no browser ownership or credentials copied into requests. */
export function nativeClient({ bridge, profileRoot, root = nativeRoot(), fetch = globalThis.fetch, input }) {
  const revealing = new Map();
  const reveal = async (binding, signal) => {
    if (signal?.aborted) return;
    const profile = browserProfileOf(binding);
    if (!revealing.has(profile)) {
      const budget = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
      const work = Promise.resolve().then(() => {
        budget.throwIfAborted();
        return bridge.call({ method: 'nativeVerification', profileRoot, auth: binding }, budget);
      }).catch(() => { /* Preserve the typed refusal even if presentation fails. */ })
        .finally(() => { if (revealing.get(profile) === work) revealing.delete(profile); });
      revealing.set(profile, work);
    }
    await revealing.get(profile);
  };
  const refusing = async (operation, binding, signal) => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof BackendError && error.code === 'verification'
          || error?.status === 403 && error.retryable === false && securityCheck({ ...error, type: error.errorType ?? error.type })) {
        await reveal(binding, signal);
      }
      throw error;
    }
  };
  return {
    async provision(auth, signal) {
      const peers = await continuityProfiles(input, auth);
      signal?.throwIfAborted();
      return bridge.call({ method: 'nativeProvision', auth, profileRoot, nativeOptions: providerNativeOptions(input),
        ...(peers ? { continuityPeers: peers } : {}) }, signal);
    },
    status: auth => readSetupStatus(auth, { root }),
    async runtime(auth, signal) {
      signal?.throwIfAborted();
      const physical = browserProfileOf(auth);
      const binding = { profile: auth.profile, ...(auth.browserProfile !== undefined ? { browserProfile: physical } : {}) };
      const peers = await continuityProfiles(input, auth);
      signal?.throwIfAborted();
      const descriptor = await refusing(() => bridge.call({ method: 'nativeRuntime', auth, profileRoot, nativeOptions: providerNativeOptions(input),
        ...(peers ? { continuityPeers: peers } : {}) }, signal), binding, signal);
      signal?.throwIfAborted();
      if (!descriptor) return null;
      const runtime = daemonProxy(descriptor, fetch);
      const wrap = operation => (body, headers, requestSignal, ...rest) => refusing(async () => {
        requestSignal?.throwIfAborted();
        const response = await operation(body, headers, requestSignal, ...rest);
        return verificationResponse(response, () => reveal(binding, requestSignal), requestSignal);
      }, binding, requestSignal);
      return { ...runtime, responses: wrap(runtime.responses), ...(runtime.compaction ? { compaction: wrap(runtime.compaction) } : {}) };
    },
    async models(auth, baseModels, catalogue) {
      if (baseModels && typeof baseModels === 'object' && !Array.isArray(baseModels) && Object.keys(baseModels).length) {
        const { profile } = identity(auth, root);
        const saved = await readNativeState({ profile }, { root });
        if (!saved) return {};
        // Site capability discovery must carry the same options as runtime RPCs.
        catalogue ??= await bridge.call({ method: 'models', auth, profileRoot, nativeOptions: providerNativeOptions(input) });
        const capabilities = Object.hasOwn(catalogue ?? {}, 'nativeCapabilities') ? catalogue.nativeCapabilities
          : { ...(catalogue?.models ? accountCapabilities(catalogue) : saved.capabilities), ...nativeOptions() };
        // A legacy backend cannot confirm effective Bigger Context. Never
        // advertise enlarged limits merely because the UI requested them.
        if (capabilities === null) return {};
        return describeNativeCatalogue(baseModels, profile, capabilities);
      }
      const peers = await continuityProfiles(input, auth);
      const descriptor = await bridge.call({ method: 'nativeRuntime', auth, profileRoot, nativeOptions: providerNativeOptions(input),
        ...(peers ? { continuityPeers: peers } : {}) });
      if (!descriptor) return {};
      return describeNativeCatalogue(nativeCatalog(descriptor.capabilities), auth.profile);
    },
  };
}
