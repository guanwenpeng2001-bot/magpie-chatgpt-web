/*
 * Behavioral port of magpie-claudeweb2api (9fed0935012c2ae2f10871b69fea365126135462).
 * MIT License — Copyright (c) 2026 木子不是木子狸
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BackendError } from '../backend/guard.mjs';
export { BackendError } from '../backend/guard.mjs';

export class Bridge {
  #child;
  #starting;
  #closed = false;
  #stopping;
  #pending = new Map();
  constructor({ spawnProcess = spawn, startupMilliseconds = 10_000, queueBytes = 8 << 20, backend = fileURLToPath(new URL('../backend/main.mjs', import.meta.url)) } = {}) {
    this.spawnProcess = spawnProcess;
    this.startupMilliseconds = startupMilliseconds;
    this.queueBytes = queueBytes;
    this.backend = backend;
  }
  start() {
    if (this.#closed) return Promise.reject(new BackendError('backendDown'));
    return this.#starting ??= this.#launch().catch(error => { this.#starting = null; throw error; });
  }
  async #launch() {
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
    let child;
    try { child = this.spawnProcess('node', [this.backend], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env }); }
    catch { throw new BackendError('backendDown'); }
    this.#child = child;
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      let ready = false;
      let buffer = '';
      const fail = error => {
        clearTimeout(timer);
        reject(error);
        if (this.#child !== child) return;
        this.#child = null;
        this.#starting = null;
        for (const item of this.#pending.values()) item.end(error);
        this.#pending.clear();
        child.kill();
      };
      const timer = setTimeout(() => fail(new BackendError('backendDown')), this.startupMilliseconds);
      child.once('error', () => fail(new BackendError('backendDown')));
      child.once('exit', () => fail(new BackendError('backendDown')));
      child.stdin.on('error', () => fail(new BackendError('backendDown')));
      child.stdout.on('data', chunk => {
        buffer += chunk;
        try {
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (Buffer.byteLength(line) > 4 << 20) throw 0;
            const frame = JSON.parse(line);
            if (!ready) {
              if (frame?.event !== 'ready' || frame.protocol !== 2) throw 0;
              ready = true; clearTimeout(timer); resolve(); continue;
            }
            if (!frame || typeof frame.id !== 'string' || !['head', 'data', 'done', 'error'].includes(frame.event)) throw 0;
            const item = this.#pending.get(frame.id);
            if (!item) continue;
            if (frame.event === 'error') item.end(BackendError.fromEnvelope(frame.error));
            else if (frame.event === 'done') item.end();
            else if (frame.event === 'head') {
              if (item.head || frame.status !== 200) throw 0;
              item.head = true;
            } else {
              if (!item.head || !Object.hasOwn(frame, 'data')) throw 0;
              const bytes = Buffer.byteLength(line);
              if (item.bytes + bytes > this.queueBytes) {
                item.end(new BackendError('protocol'));
                this.#send(child, { id: frame.id, method: 'abort' }).catch(() => {});
              } else { item.queue.push({ value: frame.data, bytes }); item.bytes += bytes; item.wake?.(); }
            }
          }
          if (Buffer.byteLength(buffer) > 4 << 20) throw 0;
        } catch { fail(new BackendError('protocol')); }
      });
    });
  }
  #send(child, frame) {
    return new Promise((resolve, reject) => {
      if (!child?.stdin.writable) return reject(new BackendError('backendDown'));
      child.stdin.write(JSON.stringify(frame) + '\n', error => error ? reject(new BackendError('backendDown')) : resolve());
    });
  }
  async open(command, signal) {
    signal?.throwIfAborted();
    await this.start();
    signal?.throwIfAborted();
    const child = this.#child;
    const id = randomUUID();
    if (this.#closed || !child) throw new BackendError('backendDown');
    if (this.#pending.size >= 64) throw new BackendError('cooldown', { retryAfter: 1 });
    const frame = { ...command, id };
    if (Buffer.byteLength(JSON.stringify(frame)) >= 16 << 20) throw new BackendError('protocol');
    const item = { queue: [], bytes: 0, ended: false, head: false };
    const abort = () => {
      this.#send(child, { id, method: 'abort' }).catch(() => {});
      item.end(new BackendError('upstream'));
    };
    item.end = error => {
      if (item.ended) return;
      item.ended = true; item.error = error;
      if (error) { item.queue = []; item.bytes = 0; }
      signal?.removeEventListener('abort', abort);
      this.#pending.delete(id);
      item.wake?.();
    };
    this.#pending.set(id, item);
    signal?.addEventListener('abort', abort, { once: true });
    try { await this.#send(child, frame); } catch (error) { item.end(error); throw error; }
    if (signal?.aborted) abort();
    return {
      async next() {
        while (!item.queue.length && !item.ended) await new Promise(resolve => { item.wake = resolve; });
        if (item.error) throw item.error;
        if (!item.queue.length) return { done: true };
        const entry = item.queue.shift(); item.bytes -= entry.bytes;
        return { done: false, value: entry.value };
      },
      close() { if (!item.ended) abort(); },
      async return() { this.close(); return { done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  }
  async call(command, signal) {
    const stream = await this.open(command, signal);
    try {
      const first = await stream.next();
      if (first.done || !(await stream.next()).done) throw new BackendError('protocol');
      return first.value;
    } finally { stream.close(); }
  }
  dispose() {
    return this.#stopping ??= this.#dispose();
  }
  async #dispose() {
    this.#closed = true;
    await this.#starting?.catch(() => {});
    const child = this.#child;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
