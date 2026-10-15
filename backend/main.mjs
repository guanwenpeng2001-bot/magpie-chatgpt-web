import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { BackendError, AccountGuard, publicError } from './guard.mjs';
import { ReadClient, productionReadClient } from './http.mjs';
import { LoginStates, createLoginFlow, sessionCredential, browserRead } from './browser.mjs';
import { TurnDriver } from './turn.mjs';

export async function serve(input, output, { handlers = {}, close = async () => {}, timeout = 300_000, signinTimeout = 300_000, loginFlow = async () => 'failed', readClient = options => new ReadClient(options), turnDriver } = {}) {
  let turns = turnDriver;
  const pending = new Map();
  const clients = new Map();
  const guards = new Map();
  const login = new LoginStates();
  let active = 0;
  const waiting = [];
  const acquire = signal => new Promise((resolve, reject) => {
    const enter = () => {
      signal.removeEventListener('abort', cancel);
      active++;
      resolve(() => { active--; waiting.shift()?.(); });
    };
    const cancel = () => {
      const index = waiting.indexOf(enter);
      if (index >= 0) waiting.splice(index, 1);
      reject(new BackendError('upstream'));
    };
    if (signal.aborted) return cancel();
    if (active < 16) enter();
    else { waiting.push(enter); signal.addEventListener('abort', cancel, { once: true }); }
  });
  let writes = Promise.resolve();
  let stopping = false;
  const send = frame => {
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > 4 << 20) return Promise.reject(new BackendError('protocol'));
    writes = writes.then(() => new Promise((resolve, reject) => output.write(line, error => error ? reject(new BackendError('backendDown')) : resolve())));
    writes.catch(() => shutdown());
    return writes;
  };
  const shutdown = () => {
    stopping = true;
    for (const entry of pending.values()) entry.controller.abort();
    input.destroy();
  };
  let clientClock = 0;
  const clientFor = command => {
    const cookie = command.auth?.refresh;
    if (typeof cookie !== 'string' || !cookie) throw new BackendError('expired');
    const session = cookie.split(';').map(pair => pair.trim()).filter(pair => /^__Secure-next-auth\.session-token(?:\.\d+)?=/.test(pair)).sort().join(';');
    const identity = createHash('sha256').update(session || cookie).digest('hex');
    const key = createHash('sha256').update(cookie).update('\0').update(String(command.origin)).digest('hex');
    if (!clients.has(key)) {
      const guard = guards.get(identity) ?? new AccountGuard();
      const client = readClient({ ...(Object.hasOwn(command, 'origin') ? { origin: command.origin } : {}), cookie, guard,
        browserRoute: async (path, signal, origin) => {
          if (typeof command.auth?.profile !== 'string' || typeof command.profileRoot !== 'string') throw new BackendError('browserConfiguration');
          turns ??= new TurnDriver({ profileRoot: command.profileRoot });
          return turns.browser.run(command.auth.profile, async context => {
            const page = await context.newPage();
            const abort = () => { page.close().catch(() => {}); };
            signal.addEventListener('abort', abort, { once: true });
            let verification = false;
            try {
              signal.throwIfAborted();
              await page.goto(origin.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
              return await browserRead(context, page, path, origin, signal);
            } catch (error) {
              if (error instanceof BackendError && error.code === 'expired') guard.observe(401);
              if (error instanceof BackendError && error.code === 'cooldown') guard.observe(429, error.retryAfter);
              verification = error instanceof BackendError && error.code === 'verification';
              throw error;
            }
            finally { signal.removeEventListener('abort', abort); if (!verification) await page.close().catch(() => {}); }
          }, signal);
        },
      });
      const idle = [...clients].filter(([, entry]) => entry.refs === 0).sort((left, right) => left[1].used - right[1].used);
      const clientVictims = new Set();
      if (clients.size >= 64) {
        if (!idle.length) throw new BackendError('capacity');
        clientVictims.add(idle[0][0]);
      }
      let guardVictim;
      if (!guards.has(identity) && guards.size >= 64) {
        guardVictim = [...guards].find(([, candidate]) => {
          if ([...clients.values()].some(entry => entry.client.guard === candidate && entry.refs > 0)) return false;
          try { candidate.restriction(); return true; } catch { return false; }
        });
        if (!guardVictim) throw new BackendError('capacity');
        clientVictims.clear();
        for (const [clientKey, entry] of clients) {
          if (entry.client.guard === guardVictim[1]) clientVictims.add(clientKey);
        }
        if (clients.size >= 64 && !clientVictims.size) clientVictims.add(idle[0][0]);
      }
      for (const clientKey of clientVictims) clients.delete(clientKey);
      if (guardVictim) guards.delete(guardVictim[0]);
      if (!guards.has(identity)) guards.set(identity, guard);
      clients.set(key, { client, refs: 0, used: 0 });
    }
    const entry = clients.get(key);
    entry.refs++;
    return { client: entry.client, identity, release: () => { entry.refs--; entry.used = ++clientClock; } };
  };
  const loginPromises = new Map();
  const startLogin = (account, profileRoot, proxy) => {
    if (loginPromises.has(account)) return;
    if (loginPromises.size >= 64) throw new BackendError('backendDown');
    login.start(account);
    const controller = new AbortController();
    const entry = { controller };
    loginPromises.set(account, entry);
    const timer = setTimeout(() => controller.abort(new BackendError('signinTimeout', { values: { windowMinutes: signinTimeout / 60_000 } })), signinTimeout);
    const settle = outcome => {
      if (loginPromises.get(account) !== entry || stopping) return;
      const reason = controller.signal.aborted ? controller.signal.reason : outcome?.error ?? outcome?.reason;
      const state = controller.signal.aborted
        ? reason?.code === 'signinTimeout' ? 'timeout' : reason?.name === 'AbortError' ? 'cancelled' : 'failed'
        : outcome?.state;
      login.finish(account, state, controller.signal.aborted ? undefined : outcome?.credential, reason);
    };
    controller.signal.addEventListener('abort', () => settle(), { once: true });
    entry.work = Promise.resolve().then(() => loginFlow(account, controller.signal, profileRoot, { proxy })).then(settle, error => settle({ state: 'failed', error })).finally(() => {
      clearTimeout(timer);
      if (loginPromises.get(account) === entry) loginPromises.delete(account);
    });
    entry.cancel = () => { clearTimeout(timer); controller.abort(); };
  };
  const dispatch = async (command, signal, emit) => {
    if (Object.hasOwn(handlers, command.method)) return handlers[command.method](command, signal, emit);
    const account = command.account ?? 'default';
    if (typeof account !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(account)) throw new BackendError('protocol');
    switch (command.method) {
      case 'models': {
        const { client, release } = clientFor(command);
        try { return await client.models(signal); } finally { release(); }
      }
      case 'session': {
        const { client, release } = clientFor(command);
        try {
          const session = await client.session(signal, { interactive: false });
          const credential = sessionCredential(session, session.refresh ?? command.auth.refresh, command.auth.profile);
          return { access: credential.access, expires: credential.expires, ...(session.refresh ? { refresh: session.refresh } : {}) };
        } finally { release(); }
      }
      case 'loginStatus': return login.status(account);
      case 'login': {
        startLogin(account, command.profileRoot, command.proxy);
        return { ok: true };
      }
      case 'logout': loginPromises.get(account)?.cancel(); loginPromises.delete(account); login.clear(account); return { ok: true };
      case 'discard': {
        if (typeof command.conversationKey !== 'string' || !command.conversationKey) throw new BackendError('invalidRequest');
        await turns?.bindings.discard(command.conversationKey);
        return { ok: true };
      }
      case 'complete': {
        if (!Array.isArray(command.history) || typeof command.model !== 'string' || typeof command.auth?.profile !== 'string') throw new BackendError('invalidRequest');
        if (command.images !== undefined) {
          const maxCount = 4;
          const maxBytes = 10 * 1024 * 1024;
          const invalid = !Array.isArray(command.images) || command.images.length > maxCount || command.images.some(image => {
            if (!image || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType) || typeof image.dataBase64 !== 'string' || !image.dataBase64.length || image.dataBase64.length > Math.ceil(maxBytes / 3) * 4) return true;
            const decoded = Buffer.from(image.dataBase64, 'base64');
            return decoded.toString('base64') !== image.dataBase64 || decoded.length > maxBytes || image.bytes !== decoded.length;
          });
          if (invalid) throw new BackendError('attachmentUnsupported', { values: { kind: 'invalid or over-cap images', maxCount, maxBytes } });
        }
        const { client, identity, release } = clientFor(command);
        try {
          turns ??= new TurnDriver({ profileRoot: command.profileRoot });
          return await turns.complete(command, client.guard, identity, signal, emit);
        } finally { release(); }
      }
      default: throw new BackendError('protocol');
    }
  };
  const accept = command => {
    if (!command || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.id) || typeof command.method !== 'string') return;
    if (command.method === 'abort') { pending.get(command.id)?.controller.abort(); return; }
    if (pending.has(command.id)) return;
    if (pending.size >= 64) { send({ id: command.id, event: 'error', error: new BackendError('cooldown', { retryAfter: 1 }).toJSON() }).catch(() => {}); return; }
    const controller = new AbortController();
    let budgetExpired = false;
    const timer = setTimeout(() => { budgetExpired = true; controller.abort(); }, command.method === 'session' ? Math.min(timeout, 10_000) : timeout);
    const entry = { controller };
    pending.set(command.id, entry);
    entry.work = (async () => {
      let onAbort;
      let release;
      try {
        release = await acquire(controller.signal);
        const aborted = new Promise((resolve, reject) => {
          onAbort = () => reject(new BackendError(budgetExpired ? 'requestBudget' : 'upstream'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        aborted.catch(() => {});
        await send({ id: command.id, event: 'head', status: 200 });
        const emit = async data => {
          controller.signal.throwIfAborted();
          await send({ id: command.id, event: 'data', data });
        };
        controller.signal.throwIfAborted();
        const result = await Promise.race([dispatch(command, controller.signal, emit), aborted]);
        controller.signal.throwIfAborted();
        if (command.method !== 'complete' && result !== undefined) await emit(result);
        const metadata = {};
        if (command.method === 'complete' && ['dom', 'sse'].includes(result?.route)) {
          metadata.route = result.route;
          if (['clone-unavailable', 'xhr-submit', 'network-disabled'].includes(result.degraded)) metadata.degraded = result.degraded;
        }
        await send({ id: command.id, event: 'done', ...metadata });
      } catch (error) {
        if (!stopping) await send({ id: command.id, event: 'error', error: publicError(budgetExpired ? new BackendError('requestBudget') : error) }).catch(() => {});
      } finally {
        clearTimeout(timer);
        release?.();
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        pending.delete(command.id);
      }
    })();
  };
  output.on('error', shutdown);
  await send({ event: 'ready', protocol: 3 });
  input.setEncoding('utf8');
  let buffer = '';
  try {
    for await (const chunk of input) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) >= 64 << 20) throw new BackendError('protocol');
        let command;
        try { command = JSON.parse(line); } catch { continue; }
        accept(command);
      }
      if (Buffer.byteLength(buffer) >= 64 << 20) throw new BackendError('protocol');
    }
  } catch { shutdown(); }
  finally {
    stopping = true;
    for (const entry of pending.values()) entry.controller.abort();
    await Promise.allSettled([...pending.values()].map(entry => entry.work));
    const logins = [...loginPromises.values()];
    for (const entry of logins) entry.cancel();
    await Promise.allSettled(logins.map(entry => entry.work));
    loginPromises.clear();
    await turns?.close();
    await close();
    await writes.catch(() => {});
    clients.clear(); guards.clear();
    output.removeListener('error', shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let missing;
  if (Number(process.versions.node.split('.')[0]) < 20) {
    missing = { component: 'Node.js >= 20', remedy: 'Install Node.js 20 or newer and retry.' };
  } else {
    try { await import('playwright-core'); }
    catch { missing = { component: 'plugin dependency', remedy: 'Reinstall the plugin to restore playwright-core, then retry.' }; }
  }
  if (missing) {
    const error = new BackendError('missingComponent', { values: missing });
    process.stdout.write(JSON.stringify({ event: 'error', code: error.code, ...missing, detail: error.message }) + '\n');
    process.exitCode = 1;
  } else {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.stdin.destroy());
    serve(process.stdin, process.stdout, { readClient: productionReadClient, loginFlow: createLoginFlow() }).catch(() => { process.exitCode = 1; });
  }
}
