import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeFile, rename, rm, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseOwnershipSnapshot } from './ownership-diagnostics.mjs';

// These are content-free lines emitted by the checksum-pinned broker itself.
// Never retain other stdout/stderr, prompt text, arguments or credential values.
const trace = '[A-Za-z0-9_-]{1,128}';
const registered = new RegExp(`^\\[chatgpt-web\\] broker trace=(${trace}) registered tokenHash=([a-f0-9]{12})$`);
const claimed = new RegExp(`^\\[chatgpt-web\\] broker claim received \\(tokenChars=(\\d{1,6}), tokenHash=([a-f0-9]{12}), valid=(true|false)(?:, retiredTurn=(${trace}))?\\)$`);
const completed = new RegExp(`^\\[chatgpt-web\\] broker trace=(${trace}) committed browser completion revision=(\\d{1,9})$`);
const validTrace = new RegExp(`^${trace}$`);
const traceHash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

export function parseBrokerDiagnostic(line) {
  if (line.startsWith('[chatgpt-web] retained_page ')) {
    let value;
    try { value = JSON.parse(line.slice('[chatgpt-web] retained_page '.length)); } catch { return; }
    if (!value || typeof value.traceId !== 'string' || !validTrace.test(value.traceId)
      || !['acquired', 'released'].includes(value.phase) || typeof value.reused !== 'boolean'
      || typeof value.compaction !== 'boolean') return;
    return { type: 'retained_page', traceHash: traceHash(value.traceId), phase: value.phase,
      reused: value.reused, compaction: value.compaction };
  }
  if (line.startsWith('[chatgpt-web] ownership ')) {
    try { return parseOwnershipSnapshot(JSON.parse(line.slice('[chatgpt-web] ownership '.length))); } catch { return; }
  }
  const phase = /^\[chatgpt-web\] compaction_phase (entered|retiring|retired)$/.exec(line);
  if (phase) return { type: 'compaction', phase: phase[1] };
  let match = registered.exec(line);
  if (match) return { type: 'registered', traceHash: traceHash(match[1]), tokenHash: match[2] };
  match = claimed.exec(line);
  if (match) return { type: 'claim', tokenChars: Number(match[1]), tokenHash: match[2], valid: match[3] === 'true',
    ...(match[4] ? { retiredTraceHash: match[4] === 'unknown' ? null : traceHash(match[4]) } : {}) };
  match = completed.exec(line);
  if (match) return { type: 'completed', traceHash: traceHash(match[1]), revision: Number(match[2]) };
  const prefix = '[chatgpt-web] broker_retired ';
  if (!line.startsWith(prefix)) return;
  let value;
  try { value = JSON.parse(line.slice(prefix.length)); } catch { return; }
  if (!value || typeof value.traceId !== 'string' || !validTrace.test(value.traceId)
    || typeof value.completionCommitted !== 'boolean') return;
  const counts = ['pendingTools', 'queuedTools', 'deliveredTools', 'activeMcpRequests'];
  if (counts.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) return;
  return { type: 'retired', traceHash: traceHash(value.traceId), completionCommitted: value.completionCommitted,
    // The pinned broker currently validates only this failure code. Do not
    // retain arbitrary error messages, tool names, or new upstream fields.
    ...(value.failure?.code === 'codex_tool_timeout' ? { failureCode: 'codex_tool_timeout' } : {}),
    ...Object.fromEntries(counts.map(key => [key, value[key]])) };
}

// One bounded snapshot per account/run. Writes coalesce while a previous write
// is pending; diagnostic I/O failures never change tool or authentication state.
export function createBrokerDiagnostics(write, { now = Date.now, limit = 128,
  drainTimeoutMs = 500, flushTimeoutMs = 500 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypeError('Invalid broker diagnostic bound');
  for (const timeout of [drainTimeoutMs, flushTimeoutMs]) {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) throw new TypeError('Invalid broker diagnostic timeout');
  }
  const runId = randomUUID(), startedAt = now(), events = [], streams = [];
  const controller = new AbortController();
  let dirty = false, pending, closed = false, droppedEvents = 0, droppedLines = 0, writeFailures = 0;
  let closing, drainTimedOut = false, flushTimedOut = false;
  const snapshot = () => ({ version: 1, runId, startedAt, closed, droppedEvents, droppedLines, writeFailures, drainTimedOut, flushTimedOut,
    events: events.map(event => ({ ...event })) });
  async function within(promise, timeout) {
    let timer;
    try {
      return await Promise.race([promise.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
  function schedule() {
    if (controller.signal.aborted) return;
    dirty = true;
    if (pending) return;
    pending = (async () => {
      while (dirty && !controller.signal.aborted) {
        dirty = false;
        try { await write(JSON.stringify(snapshot()), { signal: controller.signal }); }
        catch { writeFailures = Math.min(writeFailures + 1, Number.MAX_SAFE_INTEGER); }
      }
    })().finally(() => { pending = undefined; if (dirty) schedule(); });
  }
  function record(line) {
    if (closed) return;
    const event = parseBrokerDiagnostic(line.replace(/\r$/, ''));
    if (!event) return;
    events.push({ at: now(), ...event });
    if (events.length > limit) { events.shift(); droppedEvents++; }
    schedule();
  }
  function attach(stream) {
    if (!stream || closed || closing) return;
    const decoder = new StringDecoder('utf8');
    let partial = '', discarding = false;
    let finish;
    const ended = new Promise(resolve => { finish = resolve; });
    stream.once('end', finish); stream.once('close', finish);
    if (stream.readableEnded || stream.closed) finish();
    function data(bytes) {
      const text = decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      let offset = 0;
      while (offset < text.length) {
        const end = text.indexOf('\n', offset), through = end < 0 ? text.length : end;
        if (!discarding) {
          if (partial.length + through - offset > 4096) { partial = ''; discarding = true; droppedLines++; }
          else partial += text.slice(offset, through);
        }
        if (end < 0) break;
        if (!discarding) record(partial);
        partial = ''; discarding = false; offset = end + 1;
      }
    }
    const error = () => { droppedLines++; };
    const detach = () => {
      stream.off('data', data); stream.off('error', error);
      stream.off('end', finish); stream.off('close', finish);
      if (partial.length || discarding) droppedLines++;
      partial = ''; decoder.end();
      // Drain late bytes after the owned child exits without retaining content.
      stream.on('error', () => {}); stream.resume();
    };
    stream.on('data', data); stream.on('error', error); streams.push({ detach, ended });
  }
  async function flush() {
    if (controller.signal.aborted) return false;
    const settled = await within((async () => { while (pending) await pending; })(), flushTimeoutMs);
    if (!settled) { flushTimedOut = true; dirty = false; controller.abort(); }
    return settled;
  }
  return { attach, snapshot, flush,
    close() {
      return closing ??= (async () => {
        // A process exit can precede the last pipe data. Keep parsing until both
        // streams finish, but do not let an inherited/open pipe hold shutdown.
        drainTimedOut = !await within(Promise.all(streams.map(stream => stream.ended)), drainTimeoutMs);
        closed = true;
        for (const { detach } of streams) detach();
        streams.length = 0;
        schedule();
        await flush();
      })();
    },
  };
}

// Each generation owns a different destination AND temporary file. An async
// rename already in flight cannot be cancelled reliably; it must never target
// the next generation's artifact. Keep only the newest two generation names,
// including their temporary files. Never create directories in a delayed write.
export function createFileBrokerDiagnostics(home, { writeFile: write = writeFile, rename: commit = rename, ...options } = {}) {
  const pattern = /^broker-diagnostics-\d{16}-[a-f0-9-]{36}\.json(?:\.tmp)?$/;
  async function prune() {
    const names = (await readdir(home, { withFileTypes: true }))
      .filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => entry.name);
    const generations = [...new Set([...names.map(name => name.replace(/\.tmp$/, '')),
      basename(log.path)])].sort().reverse();
    const retained = new Set(generations.slice(0, 2));
    await Promise.all(names.filter(name => !retained.has(name.replace(/\.tmp$/, '')))
      .map(name => rm(join(home, name), { force: true })));
  }
  const log = createBrokerDiagnostics(async (value, { signal }) => {
    const temporary = `${log.path}.tmp`;
    try {
      signal.throwIfAborted();
      await prune();
      signal.throwIfAborted();
      await write(temporary, value, { flag: 'wx', mode: 0o600, signal });
      signal.throwIfAborted();
      await commit(temporary, log.path);
    } finally {
      await rm(temporary, { force: true });
      if (signal.aborted) await rm(log.path, { force: true });
      // Also prune after a late write settles; it cannot resurrect an old
      // generation beyond the retention bound. Failures remain optional I/O.
      await prune();
    }
  }, options);
  const { startedAt, runId } = log.snapshot();
  log.path = join(home, `broker-diagnostics-${String(startedAt).padStart(16, '0')}-${runId}.json`);
  return log;
}
