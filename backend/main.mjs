import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { BackendError, AccountGuard, publicError } from './guard.mjs';
import { ReadClient, productionReadClient } from './http.mjs';
import { LoginStates, createLoginFlow, sessionCredential } from './browser.mjs';

export async function serve(input, output, { handlers = {}, close = async () => {}, timeout = 300_000, loginFlow = async () => 'failed', readClient = options => new ReadClient(options) } = {}) {
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
      const client = readClient({ ...(Object.hasOwn(command, 'origin') ? { origin: command.origin } : {}), cookie, guard });
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
    return { client: entry.client, release: () => { entry.refs--; entry.used = ++clientClock; } };
  };
  const loginPromises = new Map();
  const startLogin = (account, profileRoot) => {
    if (loginPromises.has(account)) return;
    if (loginPromises.size >= 64) throw new BackendError('backendDown');
    login.start(account);
    const controller = new AbortController();
    const entry = { controller };
    loginPromises.set(account, entry);
    const timer = setTimeout(() => controller.abort(), 300_000);
    const settle = outcome => {
      if (loginPromises.get(account) !== entry || stopping) return;
      login.finish(account, controller.signal.aborted ? 'failed' : outcome?.state, controller.signal.aborted ? undefined : outcome?.credential, outcome?.error);
    };
    controller.signal.addEventListener('abort', () => settle({ state: 'failed' }), { once: true });
    entry.work = Promise.resolve().then(() => loginFlow(account, controller.signal, profileRoot)).then(settle, error => settle({ state: 'failed', error })).finally(() => {
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
          const session = await client.session(signal);
          const credential = sessionCredential(session, session.refresh ?? command.auth.refresh, command.auth.profile);
          return { access: credential.access, expires: credential.expires, ...(session.refresh ? { refresh: session.refresh } : {}) };
        } finally { release(); }
      }
      case 'loginStatus': return login.status(account);
      case 'login': {
        startLogin(account, command.profileRoot);
        return { state: 'pending' };
      }
      case 'logout': loginPromises.get(account)?.cancel(); loginPromises.delete(account); login.clear(account); return true;
      case 'discard': return true;
      case 'complete': throw new BackendError('backendDown');
      default: throw new BackendError('protocol');
    }
  };
  const accept = command => {
    if (!command || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.id) || typeof command.method !== 'string') return;
    if (command.method === 'abort') { pending.get(command.id)?.controller.abort(); return; }
    if (pending.has(command.id)) return;
    if (pending.size >= 64) { send({ id: command.id, event: 'error', error: new BackendError('cooldown', { retryAfter: 1 }).toJSON() }).catch(() => {}); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const entry = { controller };
    pending.set(command.id, entry);
    entry.work = (async () => {
      let onAbort;
      let release;
      try {
        release = await acquire(controller.signal);
        const aborted = new Promise((resolve, reject) => {
          onAbort = () => reject(new BackendError('upstream'));
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
        if (result !== undefined) await emit(result);
        await send({ id: command.id, event: 'done' });
      } catch (error) {
        if (!stopping) await send({ id: command.id, event: 'error', error: publicError(error) }).catch(() => {});
      } finally {
        clearTimeout(timer);
        release?.();
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        pending.delete(command.id);
      }
    })();
  };
  output.on('error', shutdown);
  await send({ event: 'ready', protocol: 2 });
  input.setEncoding('utf8');
  let buffer = '';
  try {
    for await (const chunk of input) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) >= 16 << 20) throw new BackendError('protocol');
        let command;
        try { command = JSON.parse(line); } catch { continue; }
        accept(command);
      }
      if (Buffer.byteLength(buffer) >= 16 << 20) throw new BackendError('protocol');
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
    await close();
    await writes.catch(() => {});
    clients.clear(); guards.clear();
    output.removeListener('error', shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.stdin.destroy());
  serve(process.stdin, process.stdout, { readClient: productionReadClient, loginFlow: createLoginFlow() }).catch(() => { process.exitCode = 1; });
}
