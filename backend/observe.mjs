import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from './guard.mjs';
import { responseFailure } from './http.mjs';
import { AnswerStream } from '../src/protocol.mjs';

export async function observeTurn(page, { run, adapter, guard, budget = 180000, signal, emit }) {
  const deadline = Date.now() + budget;
  const stream = new AnswerStream();
  let text = '';
  let carrier = 'dom';
  let degraded;
  let layout;
  let streamFailed = false;
  let domObserved = false;
  let harvestFailure;
  const log = data => emit({ event: 'log', data });
  const publish = async (next, source) => {
    if (source === 'sse' && domObserved) return;
    if (source === 'dom') domObserved = true;
    carrier = source;
    if (next === text) return;
    const delta = source === 'dom' ? next : next.slice(text.length);
    text = next;
    await emit(source === 'dom' ? { event: 'dom', data: { text } } : { event: 'answer', data: { text: delta } });
  };
  const route = () => streamFailed || stream.handedOff ? 'dom' : carrier;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (page.isClosed()) throw new BackendError('browserClosed');
    const error = await adapter.probePageError(page);
    if (error?.kind === 'challenge') throw new BackendError('verification');
    if (error?.kind === 'rate-limit') throw new BackendError('cooldown', { retryAfter: guard.observe(429) });
    if (error?.kind === 'sign-in') { guard.observe(401); throw new BackendError('expired'); }
    if (run.failure) throw run.failure;
    let eof = false;
    let partial = false;
    for (const item of run.queue.splice(0)) {
      if (item.kind === 'status' && (item.status < 200 || item.status >= 300)) throw responseFailure(item.status, item, guard, item.retryAfter);
      if (item.kind === 'eof') {
        partial ||= item.partial;
        eof = true;
      }
      if (item.kind === 'fallback') {
        degraded = { clone: 'clone-unavailable', xhr: 'xhr-submit', disabled: 'network-disabled' }[item.reason];
        streamFailed = true;
        await log({ kind: 'observationDegraded', route: 'dom', degraded });
      }
      if (item.kind === 'failure') {
        if (!['harvest', 'protocol'].includes(item.code)) throw Object.assign(new BackendError(item.code), { cause: item.cause });
        streamFailed = true;
        await log({ kind: 'observationFailure', code: item.code, cause: item.cause });
      }
      if (item.kind === 'frame' && !streamFailed) {
        try {
          const data = item.frame.data === '[DONE]' ? '[DONE]' : JSON.parse(item.frame.data);
          stream.accept({ event: item.frame.event, data });
        } catch (error) {
          if (error.code === 'hidden' || error.code === 'upstream') throw error;
          streamFailed = true;
          await log({ kind: 'observationFailure', code: 'protocol' });
        }
      }
    }
    const state = await adapter.completionState(page);
    const snapshot = await page.evaluate(layout => window.__chatgptHarvest.snapshot(layout), state.layout);
    if (state.layout !== layout) {
      layout = state.layout;
      await log({ kind: 'observationLayout', layout });
    }
    if (snapshot.failed && !harvestFailure) {
      harvestFailure = Object.assign(new BackendError('harvest'), { cause: snapshot.failed });
      streamFailed = true;
      await log({ kind: 'observationFailure', code: 'harvest', cause: snapshot.failed });
    }
    if (!streamFailed) await publish(stream.text, 'sse');
    if (snapshot.text || snapshot.nodes > 0 && state.complete) await publish(snapshot.text, 'dom');
    const domComplete = state.complete && snapshot.nodes > 0;
    const streamComplete = !streamFailed && !stream.handedOff && !partial && !domObserved && stream.complete;
    if (domComplete || streamComplete) {
      if (!text.trim()) throw new BackendError('empty');
      await emit({ event: '', data: { type: 'message_stream_complete' } });
      return { text, route: route(), ...(degraded ? { degraded } : {}) };
    }
    if (eof && !streamFailed && !stream.handedOff && !domObserved) throw new BackendError('truncated');
    await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw harvestFailure ?? new BackendError('truncated');
}
