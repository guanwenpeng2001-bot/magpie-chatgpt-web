import { join, resolve } from 'node:path';
import { ensureRuntime, nativeRoot } from './runtime.mjs';
import { NativeDaemon, writePrivate, daemonProxy } from './daemon.mjs';
import { exportStorageState, findChromeExecutable, browserEndpoint } from '../../backend/browser.mjs';
import { nativeCatalog, describeNativeCatalogue, nativeOptions, providerNativeOptions, accountCapabilities } from './models.mjs';
import { readSetupStatus, readNativeState } from './setup.mjs';

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
  const key = JSON.stringify([options.catalogOnly === true, options.resumeOnly === true, options.nativeOptions, account.capabilities]);
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
      chromeExecutablePath: account.chromeExecutablePath ?? await findChromeExecutable(), capabilities, nativeOptions: settings, storageState: async () => storage });
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

/** Plugin-side facade: no browser ownership or credentials copied into requests. */
export function nativeClient({ bridge, profileRoot, root = nativeRoot(), fetch = globalThis.fetch, input }) {
  return {
    provision: (auth, signal) => bridge.call({ method: 'nativeProvision', auth, profileRoot, nativeOptions: providerNativeOptions(input) }, signal),
    status: auth => readSetupStatus(auth, { root }),
    async runtime(auth, signal) {
      signal?.throwIfAborted();
      const descriptor = await bridge.call({ method: 'nativeRuntime', auth, profileRoot, nativeOptions: providerNativeOptions(input) }, signal);
      signal?.throwIfAborted();
      return descriptor ? daemonProxy(descriptor, fetch) : null;
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
      const descriptor = await bridge.call({ method: 'nativeRuntime', auth, profileRoot, nativeOptions: providerNativeOptions(input) });
      if (!descriptor) return {};
      return describeNativeCatalogue(nativeCatalog(descriptor.capabilities), auth.profile);
    },
  };
}
