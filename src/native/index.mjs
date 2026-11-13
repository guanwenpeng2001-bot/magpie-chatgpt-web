import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureRuntime, nativeRoot } from './runtime.mjs';
import { NativeDaemon, writePrivate, daemonProxy } from './daemon.mjs';
import { exportStorageState, findChromeExecutable, browserEndpoint } from '../../backend/browser.mjs';
import { nativeCatalog, describeNativeCatalogue } from './models.mjs';

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
  if (pending.has(home)) return pending.get(home);
  const work = (async () => {
    options.signal?.throwIfAborted();
    let saved;
    try { saved = JSON.parse(await readFile(join(home, 'native.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved && (saved.profile !== profile || !saved.tunnelId || !saved.runtimeKey || !saved.connectorId || !saved.linkId)) throw new Error('Invalid native account state');
    if (!saved && options.resumeOnly) return null;
    const existing = accounts.get(home);
    const endpoint = browserEndpoint(account.context);
    if (existing && options.resumeOnly && existing.browserEndpoint === endpoint && await existing.health()) return existing;
    if (existing) { await existing.stop(); accounts.delete(home); }
    const installed = await (options.install ?? ensureRuntime)({ root });
    const capabilities = account.capabilities ?? saved?.capabilities ?? {};
    // Snapshot while the backend holds its BrowserContext lease; crash restarts
    // must not attempt to use a context that the idle browser pool has closed.
    const storage = await exportStorageState(account.context);
    const daemon = (options.createDaemon ?? (settings => new NativeDaemon(settings)))({ home, ...installed,
      appName: `Codex Magpie ${profile.slice(0, 8)}`,
      browserEndpoint: endpoint,
      chromeExecutablePath: account.chromeExecutablePath ?? await findChromeExecutable(), capabilities, storageState: async () => storage });
    // A failed startup may still own a live OS lease until cleanup succeeds.
    // Retain it so the next attempt and shutdown can retry that cleanup.
    accounts.set(home, daemon);
    const abort = () => { void daemon.stop().catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      let result = saved;
      if (!saved || options.provision) {
        const provision = options.provision ?? (async (context, settings) => {
          const module = await import('./provision.mjs');
          return module.provision({ context, ...settings });
        });
        result = await provision(account.context, { profileId: profile, stateFile: join(home, 'provision.json'),
          saveSecret: bytes => writePrivate(join(home, 'runtime.key'), bytes),
          ensureTunnelRunning: credentials => { options.signal?.throwIfAborted(); return daemon.start(credentials); } });
      }
      options.signal?.throwIfAborted();
      await daemon.start(result);
      options.signal?.throwIfAborted();
      await writePrivate(join(home, 'native.json'), JSON.stringify({ ...result, profile, capabilities }));
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
  })().finally(() => pending.delete(home));
  pending.set(home, work);
  return work;
}

export async function hasNative(account, root = nativeRoot()) {
  const { home } = identity(account, root);
  try { const data = JSON.parse(await readFile(join(home, 'native.json'), 'utf8')); return !!(data.connectorId && data.linkId); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function stopNative() {
  await Promise.allSettled([...pending.values()]);
  await Promise.allSettled([...accounts.entries()].map(async ([home, daemon]) => {
    await daemon.stop();
    if (accounts.get(home) === daemon) accounts.delete(home);
  }));
}

/** Plugin-side facade: no browser ownership or credentials copied into requests. */
export function nativeClient({ bridge, profileRoot, root = nativeRoot(), fetch = globalThis.fetch }) {
  return {
    provision: auth => bridge.call({ method: 'nativeProvision', auth, profileRoot }),
    async runtime(auth, signal) {
      signal?.throwIfAborted();
      const descriptor = await bridge.call({ method: 'nativeRuntime', auth, profileRoot }, signal);
      signal?.throwIfAborted();
      return descriptor ? daemonProxy(descriptor, fetch) : null;
    },
    async models(auth, baseModels) {
      if (baseModels && typeof baseModels === 'object' && !Array.isArray(baseModels) && Object.keys(baseModels).length) {
        const { profile, home } = identity(auth, root);
        let saved;
        try { saved = JSON.parse(await readFile(join(home, 'native.json'), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
        if (saved?.profile !== profile || !saved.connectorId || !saved.linkId) return {};
        return describeNativeCatalogue(baseModels, profile, saved.capabilities);
      }
      const descriptor = await bridge.call({ method: 'nativeRuntime', auth, profileRoot });
      if (!descriptor) return {};
      return describeNativeCatalogue(nativeCatalog(descriptor.capabilities), auth.profile);
    },
  };
}
