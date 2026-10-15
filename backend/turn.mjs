import { randomUUID } from 'node:crypto';
import { BackendError } from './guard.mjs';
import { BrowserSupervisor } from './browser.mjs';
import { Conversations } from './conversations.mjs';
import { installHarvest } from './harvest.mjs';
import * as siteAdapter from './site-adapter/index.mjs';
import { ADAPTER_VERSION, shape } from './site-adapter/selectors.mjs';
import { observeTurn } from './observe.mjs';
import { compile } from './prompt.mjs';

export class TurnDriver {
  constructor({ profileRoot, profile, launch, origin = 'https://chatgpt.com', network = true, timeout = 180000, now = Date.now, adapter = siteAdapter, observe = observeTurn, prompter = compile } = {}) {
    this.origin = origin;
    this.network = network;
    this.timeout = timeout;
    this.now = now;
    this.adapter = adapter;
    this.observe = observe;
    this.prompter = prompter;
    this.bindings = new Conversations({ now });
    this.browser = new BrowserSupervisor({ profileRoot, profile, launch: launch ?? (async (profile, options) => {
      let chromium;
      try { ({ chromium } = await import('playwright-core')); }
      catch { throw new BackendError('browserDependency'); }
      return chromium.launchPersistentContext(profile, { ...options, serviceWorkers: 'block' });
    }) });
    this.installed = new WeakSet();
    this.turns = new Map();
  }
  async install(context) {
    if (this.installed.has(context)) return;
    await context.exposeBinding('__chatgptHarvestEvent', ({ page }, payload) => {
      const turn = this.turns.get(page);
      if (turn?.id === payload.turn) {
        if (turn.queue.length >= 1024) { turn.failure = new BackendError('harvest'); return; }
        turn.queue.push(payload);
      }
    });
    await context.addInitScript(installHarvest);
    this.installed.add(context);
  }
  async complete(command, guard, identity, signal, emit) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    const activeSignal = controller.signal;
    const deadline = this.now() + this.timeout;
    const timer = setTimeout(() => controller.abort(new BackendError('truncated')), this.timeout);
    let release;
    let binding;
    let page;
    let closePromise;
    const closePage = () => closePromise ??= Promise.resolve().then(() => page?.close()).catch(() => {});
    let interrupt;
    const interrupted = new Promise((resolve, reject) => { interrupt = reject; });
    interrupted.catch(() => {});
    const abort = () => { void closePage(); interrupt(activeSignal.reason); };
    activeSignal.addEventListener('abort', abort, { once: true });
    const wait = work => Promise.race([work, interrupted]);
    try {
      activeSignal.throwIfAborted();
      release = await guard.begin(activeSignal);
      const taken = await this.bindings.take(command, identity);
      binding = taken.entry;
      let resumeFrom = taken.resumeFrom;
      if (!Number.isInteger(resumeFrom) || resumeFrom < 0 || resumeFrom >= command.history.length) throw new BackendError('binding');
      const result = await wait(this.browser.run(command.auth.profile, async context => {
        await wait(this.install(context));
        activeSignal.throwIfAborted();
        page = binding.page;
        const fresh = !page || page.isClosed();
        if (fresh) {
          page = await context.newPage();
          binding.page = page;
          closePromise = undefined;
          if (activeSignal.aborted) { await closePage(); activeSignal.throwIfAborted(); }
          resumeFrom = 0;
          await wait(page.goto(`${this.origin}/?temporary-chat=true`, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - this.now()) }));
        }
        const temporary = await wait(this.adapter.assertTemporaryChat(page));
        await wait(this.pageError(page, guard));
        if (temporary !== true) throw new BackendError('temporary');
        this.assertResult(await wait(this.adapter.readComposer(page)), command.model);
        this.assertResult(await wait(this.adapter.selectModel(page, command.model)), command.model);
        if (command.images?.length) this.assertResult(await wait(this.adapter.attachImages(page, command.images)), command.model);
        activeSignal.throwIfAborted();
        const prompt = this.prompter(command, resumeFrom);
        const run = { id: randomUUID(), queue: [] };
        this.turns.set(page, run);
        await wait(page.evaluate(({ id, network }) => window.__chatgptHarvest.start(id, network), { id: run.id, network: this.network }));
        const composer = page.locator(shape.composer).filter({ visible: true });
        await wait(composer.fill(prompt));
        activeSignal.throwIfAborted();
        await wait(composer.press('Enter'));
        return await wait(this.observe(page, { run, adapter: this.adapter, guard, budget: Math.max(0, deadline - this.now()), signal: activeSignal, emit: async () => {} }));
      }, activeSignal, { visibleTurns: command.visibleTurns, auth: command.auth, origin: this.origin }));
      activeSignal.throwIfAborted();
      await wait(emit({ type: 'delta', index: 0, text: result.text }));
      await wait(emit({ type: 'finish', reason: 'complete' }));
      activeSignal.throwIfAborted();
      this.bindings.finish(binding, command, result.text);
      return result;
    } catch (error) {
      let failure = error;
      if (!(failure instanceof BackendError)) {
        if (activeSignal.aborted) failure = activeSignal.reason instanceof BackendError ? activeSignal.reason : new BackendError('upstream');
        else if (error?.message === 'An active operation holds the browser context in the other mode. Wait for it to finish before switching modes.') failure = new BackendError('invalidRequest');
        else failure = new BackendError('upstream');
      }
      await closePage();
      if (binding) await this.bindings.failed(binding);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      activeSignal.removeEventListener('abort', abort);
      if (page) {
        this.turns.delete(page);
        if (!page.isClosed()) await page.evaluate(() => window.__chatgptHarvest?.stop()).catch(() => {});
      }
      if (binding && !binding.key) await this.bindings.failed(binding);
      release?.();
    }
  }
  assertResult(result, slug) {
    if (result.ok) return;
    const detail = result.detail ?? {};
    switch (result.kind) {
      case 'composer-missing': throw new BackendError('pickerMissing', { values: { component: 'composer', selector: shape.composer, adapterVersion: ADAPTER_VERSION } });
      case 'picker-missing': throw new BackendError('pickerMissing', { values: detail });
      case 'picker-ambiguous': throw new BackendError('pickerAmbiguous', { values: { slug, count: detail.count } });
      case 'model-not-offered': throw new BackendError('modelNotOffered', { values: { slug } });
      case 'attach-unavailable': throw new BackendError('attachmentUnsupported', { values: { kind: 'images without an upload control', maxCount: 4, maxBytes: 10 * 1024 * 1024 } });
      case 'image-rejected': throw new BackendError('imageRejected', { values: { detail: detail.reason } });
      default: throw new BackendError('protocol');
    }
  }
  async pageError(page, guard) {
    const state = await this.adapter.probePageError(page);
    if (state?.kind === 'challenge') throw new BackendError('verification');
    if (state?.kind === 'rate-limit') throw new BackendError('cooldown', { retryAfter: guard.observe(429) });
    if (state?.kind === 'sign-in') { guard.observe(401); throw new BackendError('expired'); }
  }
  async close() { await this.bindings.close(); await this.browser.close(); }
}
