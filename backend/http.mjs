import http from 'node:http';
import https from 'node:https';
import { BackendError, AccountGuard } from './guard.mjs';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const production = Symbol('production read origin');

export function productionReadClient(options) {
  if (Object.hasOwn(options, 'origin')) throw new BackendError('protocol');
  return new ReadClient({ ...options, origin: 'https://chatgpt.com', authority: production });
}

export function challengeEvidence(headers, body = '') {
  return {
    mitigated: headers['cf-mitigated'] === 'challenge',
    interstitial: /text\/html/i.test(headers['content-type'] ?? '') && body.includes('/cdn-cgi/challenge-platform') && /Enable JavaScript and cookies to continue|Just a moment/i.test(body),
  };
}

export function responseFailure(status, evidence = {}, guard, retryAfter) {
  if (status === 200) return;
  if (status === 403 && (evidence.mitigated === true || evidence.interstitial === true)) return new BackendError('verification');
  const cooldown = guard?.observe(status, retryAfter);
  return new BackendError(status === 401 || status === 403 ? 'expired' : status === 429 ? 'cooldown' : 'upstream', { retryAfter: cooldown ?? retryAfter });
}

export class ReadClient {
  #cookie;
  #storedCookie;
  #catalog;
  #expires = 0;
  constructor({ origin, cookie, guard = new AccountGuard(), timeout = 20_000, authority, browserRoute }) {
    try {
      this.origin = new URL(origin);
      if (this.origin.username || this.origin.password || this.origin.pathname !== '/' || this.origin.search || this.origin.hash || !['http:', 'https:'].includes(this.origin.protocol)) throw 0;
      if (authority === production ? this.origin.href !== 'https://chatgpt.com/' : !['127.0.0.1', '[::1]'].includes(this.origin.hostname)) throw 0;
    } catch { throw new BackendError('protocol'); }
    if (typeof cookie !== 'string' || !cookie || /[\r\n\0]/.test(cookie)) throw new BackendError('expired');
    this.#cookie = cookie;
    this.#storedCookie = cookie;
    this.guard = guard;
    this.timeout = timeout;
    this.browserRoute = browserRoute;
  }
  async #read(path, signal, receiveCookies = () => {}, { browserFallback = true } = {}) {
    const transport = this.origin.protocol === 'https:' ? https : http;
    const budget = AbortSignal.timeout(this.timeout);
    const bounded = AbortSignal.any([budget, ...(signal ? [signal] : [])]);
    try {
      return await new Promise((resolve, reject) => {
        const request = transport.get(new URL(path, this.origin), {
          agent: false, signal: bounded,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close', Cookie: this.#cookie },
        }, response => {
          const status = response.statusCode;
          if (status !== 200 && (status !== 403 || response.headers['cf-mitigated'] === 'challenge')) {
            const failure = responseFailure(status, challengeEvidence(response.headers), this.guard, response.headers['retry-after']);
            response.resume();
            reject(failure);
            return;
          }
          let body = '';
          let bytes = 0;
          response.setEncoding('utf8');
          response.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (status === 403 && bytes > 65536) {
              body += chunk.slice(0, Math.max(0, 65536 - Buffer.byteLength(body)));
              const failure = responseFailure(status, challengeEvidence(response.headers, body), this.guard, response.headers['retry-after']);
              response.destroy(); reject(failure); return;
            }
            if (bytes > 4 * 1024 * 1024) { response.destroy(); reject(new BackendError('protocol')); return; }
            body += chunk;
          });
          response.on('error', () => reject(status === 403 ? responseFailure(status, challengeEvidence(response.headers, body), this.guard) : new BackendError('upstream')));
          response.on('end', () => {
            const failure = responseFailure(status, challengeEvidence(response.headers, body), this.guard, response.headers['retry-after']);
            if (failure) { reject(failure); return; }
            try {
              const value = JSON.parse(body);
              receiveCookies(response.headers['set-cookie'] ?? []);
              resolve(value);
            } catch { reject(new BackendError('protocol')); }
          });
        });
        request.on('error', () => reject(new BackendError('upstream')));
      });
    } catch (error) {
      if (error instanceof BackendError && error.code === 'verification' && browserFallback && this.browserRoute && !bounded.aborted) {
        const fallbackBudget = AbortSignal.timeout(this.timeout);
        const fallbackSignal = AbortSignal.any([fallbackBudget, ...(signal ? [signal] : [])]);
        let abort;
        try {
          const interrupted = new Promise((resolve, reject) => {
            abort = () => reject(new BackendError(fallbackBudget.aborted && !signal?.aborted ? 'requestBudget' : 'upstream'));
            fallbackSignal.addEventListener('abort', abort, { once: true });
            if (fallbackSignal.aborted) abort();
          });
          const result = await Promise.race([this.browserRoute(path, fallbackSignal, this.origin), interrupted]);
          fallbackSignal.throwIfAborted();
          if (path === '/api/auth/session') {
            const cookies = this.#cookie.split(';').map(pair => pair.trim()).filter(pair => !/^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?=/.test(pair));
            const sessionCookies = result.cookies.split(';').map(pair => pair.trim()).filter(pair => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?=/.test(pair));
            if (!sessionCookies.length) { this.guard.observe(401); throw new BackendError('expired'); }
            const updated = [...cookies, ...sessionCookies].join('; ');
            this.#cookie = updated;
          }
          return result.value;
        } catch (failure) {
          if (failure instanceof BackendError && failure.code === 'expired') this.guard.observe(401);
          if (failure instanceof BackendError && failure.code === 'cooldown') this.guard.observe(429, failure.retryAfter);
          if (fallbackBudget.aborted && !signal?.aborted) throw new BackendError('requestBudget');
          throw failure instanceof BackendError ? failure : new BackendError('upstream');
        } finally { fallbackSignal.removeEventListener('abort', abort); }
      }
      if (budget.aborted && !signal?.aborted) throw new BackendError('requestBudget');
      throw error instanceof BackendError ? error : new BackendError('upstream');
    }
  }
  async models(signal) {
    const release = await this.guard.begin(signal);
    try {
      if (this.#catalog && this.#expires > Date.now()) return structuredClone(this.#catalog);
      const value = await this.#read('/backend-api/models', signal);
      if (!Array.isArray(value?.models) || !value.models.length || value.models.some(model => typeof model?.slug !== 'string' || !model.slug || typeof model.title !== 'string')) throw new BackendError('protocol');
      this.#catalog = value;
      this.#expires = Date.now() + 60_000;
      return structuredClone(value);
    } finally { release(); }
  }
  async session(signal, { interactive = false } = {}) {
    const budget = interactive ? undefined : AbortSignal.timeout(Math.min(this.timeout, 10_000));
    const bounded = budget ? AbortSignal.any([budget, ...(signal ? [signal] : [])]) : signal;
    let release;
    try {
      release = await this.guard.begin(bounded);
      let rotations = [];
      const value = await this.#read('/api/auth/session', bounded, cookies => { rotations = cookies; }, { browserFallback: interactive });
      if (typeof value?.accessToken !== 'string' || !value.accessToken.trim()) {
        this.guard.observe(401);
        throw new BackendError('expired');
      }
      const cookies = new Map(this.#cookie.split(';').map(pair => {
        const at = pair.indexOf('=');
        return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
      }));
      for (const rotation of rotations) {
        const [pair, ...attributes] = rotation.split(';');
        const at = pair.indexOf('=');
        if (at <= 0) throw new BackendError('protocol');
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        const options = new Map(attributes.map(attribute => {
          const at = attribute.indexOf('=');
          return [attribute.slice(0, at < 0 ? undefined : at).trim().toLowerCase(), at < 0 ? '' : attribute.slice(at + 1).trim()];
        }));
        const domain = options.get('domain')?.replace(/^\./, '').toLowerCase();
        if (domain && domain !== this.origin.hostname) continue;
        if (options.has('path') && options.get('path') !== '/') continue;
        const deleted = options.has('max-age') ? Number(options.get('max-age')) <= 0 : Date.parse(options.get('expires')) <= Date.now();
        if (deleted) cookies.delete(name); else cookies.set(name, value);
      }
      const refresh = [...cookies].map(([name, value]) => name + '=' + value).join('; ');
      const changed = rotations.length > 0 && refresh !== this.#cookie;
      if (changed) this.#cookie = refresh;
      delete value.refresh;
      return { ...value, ...(this.#cookie !== this.#storedCookie ? { refresh: this.#cookie } : {}) };
    } catch (error) {
      if (budget?.aborted && !signal?.aborted) throw new BackendError('requestBudget');
      throw error instanceof BackendError ? error : new BackendError('upstream');
    } finally { release?.(); }
  }
}
