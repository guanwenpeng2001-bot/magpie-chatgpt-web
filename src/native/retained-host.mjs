import { NativeRetainedPages } from './retained-pages.mjs';

// A managed browser is not a Launcher. This adapter owns only pages it creates
// in its existing browser context, and reuses the pinned worker's normal
// selection, connector attachment, submission and completion checks.
export function installNativeManagedRetention(Worker, { unavailable, accepted, enabled = () => process.env.MAGPIE_NATIVE_RETAINED_COMPACTION === '1' }) {
  const registries = new WeakMap();
  const closing = new WeakSet();
  const closeRuns = new WeakMap();
  const original = Worker.prototype.runExclusive;
  const originalClose = Worker.prototype.close;
  if (Worker.prototype.supportsNativeManagedRetention) throw new Error('Managed retention already installed');
  const registry = worker => {
    let value = registries.get(worker);
    if (!value) { value = new NativeRetainedPages({ unavailable }); registries.set(worker, value); }
    return value;
  };
  Worker.prototype.supportsNativeManagedRetention = function () {
    return this.config.browserHost === 'managed-chrome' && enabled();
  };
  Worker.prototype.releaseNativeRetainedConversation = function (key) {
    return registries.get(this)?.release(key) ?? Promise.resolve();
  };
  Worker.prototype.runExclusive = async function (turn) {
    if (!this.supportsNativeManagedRetention() || !turn.conversationKey) return original.call(this, turn);
    if (closing.has(this)) throw new Error('Managed retained browser is closing');
    const lease = await registry(this).acquire({ key: turn.conversationKey, identity: { appName: this.config.appName },
      requireRetained: turn.requireRetainedConversation === true,
      canResume: typeof turn.prepareResume === 'function', signal: turn.abortSignal });
    turn = { ...turn, abortSignal: turn.abortSignal ? AbortSignal.any([turn.abortSignal, lease.signal]) : lease.signal };
    let completed = false;
    try {
      console.info('[chatgpt-web] retained_page ' + JSON.stringify({ traceId: turn.traceId,
        phase: 'acquired', reused: lease.reused, compaction: turn.compaction === true }));
      await turn.onPreparedSelected?.(lease.reused);
      // Lazy acquisition runs after the original compiler and limits checks.
      // A maintenance-page callback prevents the worker from closing the page;
      // this lease remains responsible through final physical cleanup.
      const page = signal => lease.page(() => this.pageForNewTurn(), signal);
      const answer = await this.runBrowserTurn(turn, undefined, page, lease.reused, false);
      completed = true;
      return answer;
    } catch (error) {
      completed = accepted(error);
      throw error;
    } finally {
      await lease.finish({ completed, retain: turn.retainConversation === true,
        connectorBound: turn.nativeConnector === true || turn.capabilities.localToolsEnabled === true });
      console.info('[chatgpt-web] retained_page ' + JSON.stringify({ traceId: turn.traceId,
        phase: 'released', reused: lease.reused, compaction: turn.compaction === true }));
    }
  };
  Worker.prototype.close = function () {
    if (closeRuns.has(this)) return closeRuns.get(this);
    closing.add(this);
    // The reference close waits physical active runs before disconnecting. The
    // registry independently waits those leases, then closes only owned pages.
    const run = (async () => {
      const errors = [];
      try { await registries.get(this)?.close(); } catch (error) { errors.push(error); }
      // A failed Page.close must not prevent the reference disconnecting its
      // browser transport. Keep the registry tombstones until a retry succeeds.
      try { await originalClose.call(this); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Managed retained browser cleanup failed');
      registries.delete(this);
      closing.delete(this);
    })();
    closeRuns.set(this, run);
    void run.finally(() => closeRuns.delete(this)).catch(() => {});
    return run;
  };
}

// Self-contained for the checksum-verified preload. No descriptor fabrication,
// tool/environment bypass, changed token budget or new summary acceptance path.
export function patchNativeManagedRetention(source) {
  const edits = [
    ['Xu(Re(e.chatgptWeb.browserHostDescriptorPath)):void 0;if(u){',
      'Xu(Re(e.chatgptWeb.browserHostDescriptorPath)):void 0;const magpieManagedRetention=!u&&n.supportsNativeManagedRetention?.()===true;if(u){'],
    ['&&(b.localTools||f.modelId===Ie&&c)&&h?Di(y.parsed,p):void 0',
      '&&(b.localTools||f.modelId===Ie&&c)&&(h||magpieManagedRetention)?Di(y.parsed,p):void 0'],
    ['X=P&&h?async()=>{await gp(h,P)}:void 0',
      'X=P&&(h||magpieManagedRetention)?async()=>{if(magpieManagedRetention)await n.releaseNativeRetainedConversation(P);else await gp(h,P)}:void 0'],
    ['let oe=(f.modelId!==Ie||c)&&l.localToolsEnabled&&!(e.chatgptWeb?.browserHost==="managed-chrome"&&e.chatgptWeb?.browserInteractionMode==="automatic");',
      'let oe=(f.modelId!==Ie||c)&&l.localToolsEnabled&&(!(e.chatgptWeb?.browserHost==="managed-chrome"&&e.chatgptWeb?.browserInteractionMode==="automatic")||magpieManagedRetention);'],
    ['if(oe&&(!h||!_&&!i)){', 'if(oe&&(!(h||magpieManagedRetention)||!_&&!i)){'],
    ['if(n)return n;if(!t){let V=await this.pageForNewTurn();',
      'if(n)return typeof n==="function"?await n(E):n;if(!t){let V=await this.pageForNewTurn();'],
    ['Rk().catch((e)=>{process.stderr.write(',
      'installNativeManagedRetention(Cs,{unavailable:ml,accepted:e=>e instanceof Dn});Rk().catch((e)=>{process.stderr.write('],
  ];
  for (const [before] of edits) if (source.split(before).length !== 2) throw new Error('Native managed retention anchor mismatch');
  for (const [before, after] of edits) source = source.replace(before, () => after);
  return source;
}
