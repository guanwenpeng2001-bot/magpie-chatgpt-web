import http from 'node:http';
import https from 'node:https';
import { BackendError, AccountGuard } from './guard.mjs';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
export class ReadClient {
  #cookie;
  #catalog;
  #expires = 0;
  constructor({ origin, cookie, guard = new AccountGuard(), timeout = 20_000 }) {
    try {
      this.origin = new URL(origin);
      if (this.origin.username || this.origin.password || this.origin.pathname !== '/' || this.origin.search || this.origin.hash || !['http:', 'https:'].includes(this.origin.protocol)) throw 0;
      if (!['127.0.0.1', '[::1]'].includes(this.origin.hostname)) throw 0;
    } catch { throw new BackendError('protocol'); }
    if (typeof cookie !== 'string' || !cookie || /[\r\n\0]/.test(cookie)) throw new BackendError('expired');
    this.#cookie = cookie;
    this.guard = guard;
    this.timeout = timeout;
  }
  async #read(path, signal) {
    const transport = this.origin.protocol === 'https:' ? https : http;
    const bounded = AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]);
    try {
      return await new Promise((resolve, reject) => {
        const request = transport.get(new URL(path, this.origin), {
          agent: false, signal: bounded,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close', Cookie: this.#cookie },
        }, response => {
          const status = response.statusCode;
          const retryAfter = this.guard.observe(status, response.headers['retry-after']);
          if (status !== 200) {
            response.resume();
            reject(new BackendError(status === 401 || status === 403 ? 'expired' : status === 429 ? 'cooldown' : 'upstream', { retryAfter }));
            return;
          }
          let body = '';
          let bytes = 0;
          response.setEncoding('utf8');
          response.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 4 * 1024 * 1024) { response.destroy(); reject(new BackendError('protocol')); return; }
            body += chunk;
          });
          response.on('error', () => reject(new BackendError('upstream')));
          response.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { reject(new BackendError('protocol')); }
          });
        });
        request.on('error', () => reject(new BackendError('upstream')));
      });
    } catch (error) { throw error instanceof BackendError ? error : new BackendError('upstream'); }
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
  async session(signal) {
    const release = await this.guard.begin(signal);
    try {
      const value = await this.#read('/api/auth/session', signal);
      if (typeof value?.accessToken !== 'string' || !value.accessToken.trim()) {
        this.guard.observe(401);
        throw new BackendError('expired');
      }
      return value;
    } finally { release(); }
  }
}
