import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from './guard.mjs';
import { responseFailure } from './http.mjs';
import { AnswerStream } from '../src/wire/translate.mjs';

export async function observeTurn(page, { run, adapter, guard, budget = 180000, signal, emit }) {
  const deadline = Date.now() + budget;
  const stream = new AnswerStream();
  let text = '';
  let carrier = 'dom';
  let degraded;
  let layout;
  let streamFailed = false;
  let domObserved = false;
  let streamStarted = false;
  let streamEnded = false;
  let partial = false;
  let harvestFailure;
  let emptyCompletions = 0;
  const log = data => emit({ event: 'log', data });
  const publish = async (next, source) => {
    if (source === 'dom') {
      domObserved = true;
    }
    carrier = source;
    if (next === text) return;
    const append = source === 'sse' && next.startsWith(text);
    const delta = append ? next.slice(text.length) : next;
    text = next;
    await emit(append ? { event: 'answer', data: { text: delta } } : { event: 'dom', data: { text, source } });
  };
  const route = () => streamFailed || stream.handedOff ? 'dom' : carrier;
  const drain = async () => {
    let eof = false;
    for (const item of run.queue.splice(0)) {
      if (item.kind === 'status' || item.kind === 'frame') streamStarted = true;
      if (item.kind === 'status' && (item.status < 200 || item.status >= 300)) throw responseFailure(item.status, item, guard, item.retryAfter);
      if (item.kind === 'eof') {
        partial ||= item.partial;
        eof = true;
        streamEnded = true;
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
          let data = item.frame.data === '[DONE]' ? '[DONE]' : JSON.parse(item.frame.data);
          if (typeof data === 'string' && data !== '[DONE]' && /^[\[{]/.test(data.trim())) data = JSON.parse(data);
          stream.accept({ event: item.frame.event, data });
        } catch (error) {
          if (error.code === 'hidden' || error.code === 'upstream') throw error;
          streamFailed = true;
          await log({ kind: 'observationFailure', code: 'protocol', frameType: item.frame.event });
        }
      }
    }
    return eof;
  };
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (page.isClosed()) throw new BackendError('browserClosed');
    const error = await adapter.probePageError(page);
    if (error?.kind === 'challenge') throw new BackendError('verification');
    if (error?.kind === 'rate-limit') throw new BackendError('cooldown', { retryAfter: guard.observe(429) });
    if (error?.kind === 'sign-in') { guard.observe(401); throw new BackendError('expired'); }
    if (run.failure) throw run.failure;
    let eof = await drain();
    const state = await adapter.completionState(page);
    const snapshot = await page.evaluate(layout => window.__chatgptHarvest.snapshot(layout), state.layout);
    domObserved ||= Boolean(snapshot.text);
    if (state.layout !== layout) {
      layout = state.layout;
      await log({ kind: 'observationLayout', layout });
    }
    if (snapshot.failed && !harvestFailure) {
      harvestFailure = Object.assign(new BackendError('harvest'), { cause: snapshot.failed });
      streamFailed = true;
      await log({ kind: 'observationFailure', code: 'harvest', cause: snapshot.failed });
    }
    // Harvest delivery may arrive while DOM reads are awaited. Reconcile it
    // before accepting that snapshot's terminal state or publishing its text.
    if (run.queue.length) eof = (await drain()) || eof;
    const healthy = !streamFailed && !stream.handedOff;
    const activeStream = healthy && streamStarted && !streamEnded && !stream.complete;
    const domComplete = state.complete && snapshot.nodes > 0;
    // While the network owns this answer, DOM markdown rendering cannot replace
    // its text or finish the turn. Full snapshots preserve un-emitted revisions.
    if (healthy && stream.text) await publish(stream.text, 'sse');
    else if (!activeStream && snapshot.text && (!run.networkExpected || !healthy || streamEnded || domComplete)) await publish(snapshot.text, 'dom');
    const streamComplete = healthy && !partial && stream.complete;
    if (streamComplete || (domComplete && !activeStream)) {
      if (healthy && stream.complete && !partial && stream.text) {
        await publish(stream.text, snapshot.text === stream.text ? 'dom' : 'sse');
      } else if (snapshot.text) await publish(snapshot.text, 'dom');
      if (text.trim()) {
        await emit({ event: '', data: { type: 'message_stream_complete' } });
        return { text, route: route(), ...(degraded ? { degraded } : {}) };
      }
      // Terminal state can render before its text child. Confirm an empty
      // result on the next normal observation rather than failing that frame.
      if (++emptyCompletions >= 2) throw new BackendError('empty');
    } else emptyCompletions = 0;
    if (eof && !streamFailed && !stream.handedOff && !domObserved && !emptyCompletions) throw new BackendError('truncated');
    await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw harvestFailure ?? new BackendError('truncated');
}
