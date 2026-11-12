import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from './guard.mjs';
import { BrowserSupervisor, launchChatBrowserContext } from './browser.mjs';
import { Conversations } from './conversations.mjs';
import { installHarvest } from './harvest.mjs';
import * as siteAdapter from './site-adapter/index.mjs';
import { ADAPTER_VERSION, shape } from './site-adapter/selectors.mjs';
import { wireModels, workModels } from './site-adapter/compatibility.mjs';
import { IMAGE_MODEL } from './site-adapter/images.mjs';
import { observeTurn } from './observe.mjs';
import { compile } from './prompt.mjs';
import { normalizeAssistantContent } from '../src/tool-emulation.mjs';

const challengeText = new RegExp(shape.challengeCard, 'i');

export class TurnDriver {
  constructor({ profileRoot, profile, artifactRoot, launch, origin = 'https://chatgpt.com', network = true, timeout = 180000, challengeTimeout = timeout, now = Date.now, adapter = siteAdapter, observe = observeTurn, prompter = compile } = {}) {
    this.origin = origin;
    this.artifactRoot = artifactRoot ?? resolve(profileRoot ?? profile ?? '.', '..', 'chatgpt-web-artifacts');
    this.network = network;
    this.timeout = timeout;
    this.challengeTimeout = challengeTimeout;
    this.now = now;
    this.adapter = adapter;
    this.observe = observe;
    this.prompter = prompter;
    this.bindings = new Conversations({ now });
    this.browser = new BrowserSupervisor({ profileRoot, profile, idleMilliseconds: null, headless: false, launch: launch ?? (async (profile, options) => {
      return launchChatBrowserContext(profile, { ...options, serviceWorkers: 'block' });
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
    const workMode = Object.hasOwn(workModels, command.model);
    const imageMode = command.model === IMAGE_MODEL;
    const wireModel = Object.hasOwn(wireModels, command.model) ? command.model : undefined;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    const activeSignal = controller.signal;
    const deadline = this.now() + this.timeout;
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new BackendError('truncated'));
    }, this.timeout);
    let release;
    let binding;
    let page;
    let checkpoint;
    let challengeSeen = false;
    let preservePage = false;
    let holdTurn = false;
    let closePromise;
    const closePage = () => closePromise ??= Promise.resolve().then(() => page?.close()).catch(() => {});
    let interrupt;
    const interrupted = new Promise((resolve, reject) => { interrupt = reject; });
    interrupted.catch(() => {});
    let stopPromise;
    const stopPage = () => stopPromise ??= (async () => {
      if ((workMode || imageMode) && page) await this.adapter.stopWork?.(page).catch(() => {});
      await closePage();
    })();
    const abort = () => {
      if (!preservePage && !(challengeSeen && deadlineExpired)) void stopPage();
      interrupt(activeSignal.reason);
    };
    activeSignal.addEventListener('abort', abort, { once: true });
    const wait = work => Promise.race([work, interrupted]);
    let streamedText = '';
    let streamed = false;
    const emitObservation = async observation => {
      let next;
      if (observation.event === 'dom' && typeof observation.data?.text === 'string') next = observation.data.text;
      else if (observation.event === 'answer' && typeof observation.data?.text === 'string') next = streamedText + observation.data.text;
      else return;
      if (challengeText.test(next)) return;
      if (!next.startsWith(streamedText)) return;
      const delta = next.slice(streamedText.length);
      if (!delta) return;
      streamedText = next;
      streamed = true;
      await emit({ type: 'delta', index: 0, text: delta });
    };
    try {
      activeSignal.throwIfAborted();
      release = await guard.begin(activeSignal);
      const taken = await this.bindings.take(command, identity);
      binding = taken.entry;
      let resumeFrom = taken.resumeFrom;
      if (!Number.isInteger(resumeFrom) || resumeFrom < 0 || resumeFrom >= command.history.length) throw new BackendError('binding');
      const pendingChallenge = binding.pendingChallenge;
      const effectiveVisible = command.visibleTurns === true || Boolean(pendingChallenge);
      const backgroundTurn = command.visibleTurns !== true;
      const result = await wait(this.browser.run(command.auth.profile, async context => {
        await wait(this.install(context));
        activeSignal.throwIfAborted();
        page = binding.page;
        const fresh = !page || page.isClosed();
        let promptSubmitted = Boolean(pendingChallenge?.submitted);
        let run = pendingChallenge?.run;
        let imageBaseline = pendingChallenge?.imageBaseline;
        let navigated = !fresh;
        let challengeRecoveries = 0;
        let harvestStarted = false;
        if (fresh) {
          page = await context.newPage();
          binding.page = page;
          closePromise = undefined;
          if (activeSignal.aborted) { await closePage(); activeSignal.throwIfAborted(); }
          resumeFrom = 0;
          delete binding.pendingChallenge;
          promptSubmitted = false;
          run = undefined;
          imageBaseline = undefined;
        }
        const rememberCheckpoint = () => {
          checkpoint = {
            submitted: promptSubmitted,
            run,
            imageBaseline,
            historyDigest: createHash('sha256').update(JSON.stringify(command.history)).digest('hex'),
          };
          if (binding.key) binding.pendingChallenge = checkpoint;
        };
        const returnToBackground = async () => {
          if (!backgroundTurn) return;
          let hidden = await this.browser.setBackground(command.auth.profile, true, activeSignal);
          if (!hidden) hidden = await this.browser.setBackground(command.auth.profile, true, activeSignal);
          if (!hidden) throw new BackendError('backendDown');
        };
        const recoverChallenge = async () => {
          if (++challengeRecoveries > 3) {
            preservePage = true;
            throw new BackendError('verification');
          }
          challengeSeen = true;
          preservePage = true;
          rememberCheckpoint();
          const revealed = await this.browser.setBackground(command.auth.profile, false, activeSignal);
          if (!revealed) throw new BackendError('backendDown');
          const budget = Math.max(0, Math.min(deadline - this.now(), this.challengeTimeout));
          if (!budget) throw new BackendError('verification');
          try {
            let recoveryState;
            for (let attempt = 0; attempt < 5; attempt++) {
              recoveryState = await this.adapter.probePageError(page);
              if (recoveryState?.kind === 'challenge') break;
              if (recoveryState?.kind === 'rate-limit' || recoveryState?.kind === 'sign-in') {
                await wait(this.pageError(page, guard));
              }
              if (attempt < 4) await delay(100, undefined, { signal: activeSignal });
            }
            if (recoveryState?.kind !== 'challenge') throw new BackendError('verification');
            if (this.adapter.waitForReady) {
              await wait(this.adapter.waitForReady(page, { signal: activeSignal, budget, requirePicker: command.visibleTurns === true && !workMode && !imageMode }));
            } else {
              const until = this.now() + budget;
              for (;;) {
                activeSignal.throwIfAborted();
                if (this.now() >= until) throw new BackendError('verification');
                const state = await this.adapter.probePageError(page);
                if (!state) break;
                if (state.kind !== 'challenge') {
                  await wait(this.pageError(page, guard));
                }
                await delay(Math.min(200, Math.max(0, until - this.now())), undefined, { signal: activeSignal });
              }
            }
            await wait(this.pageError(page, guard));
            await returnToBackground();
          } catch (error) {
            if (activeSignal.aborted && !deadlineExpired) {
              preservePage = false;
              throw error;
            }
            if (error?.code === 'expired' || error?.code === 'cooldown' || error?.code === 'browserClosed') {
              preservePage = false;
              throw error;
            }
            throw new BackendError('verification');
          }
          preservePage = false;
        };
        const ensurePageError = async () => {
          for (;;) {
            try {
              await wait(this.pageError(page, guard));
              return;
            } catch (error) {
              if (error?.code !== 'verification') throw error;
              await recoverChallenge();
            }
          }
        };
        const waitForOrdinaryReady = async (requirePicker = false) => {
          if (workMode || imageMode || !this.adapter.waitForReady) return;
          for (let readinessAttempt = 0; readinessAttempt < 3; readinessAttempt++) {
            activeSignal.throwIfAborted();
            const budget = Math.max(0, deadline - this.now());
            if (!budget) throw new BackendError('truncated');
            try {
              await wait(this.adapter.waitForReady(page, { signal: activeSignal, budget: Math.min(1000, budget), requirePicker }));
              return;
            } catch (error) {
              if (error?.code === 'verification') {
                await recoverChallenge();
                continue;
              }
              if (error?.code !== 'pageShape') throw error;
              if (readinessAttempt === 2) throw new BackendError('pickerMissing', { values: {
                component: 'composer', selector: shape.composer, adapterVersion: ADAPTER_VERSION,
              } });
              await delay(100, undefined, { signal: activeSignal });
            }
          }
        };
        const startHarvest = async () => {
          this.turns.set(page, run);
          await wait(page.evaluate(({ id, network, model }) => window.__chatgptHarvest.start(id, network, model), {
            id: run.id, network: this.network && !command.visibleTurns && !workMode && !imageMode, model: wireModel,
          }));
          harvestStarted = true;
        };
        if (pendingChallenge) {
          challengeSeen = true;
          await ensurePageError();
          if (backgroundTurn) {
            preservePage = true;
            await returnToBackground();
            preservePage = false;
          }
        }
        while (!promptSubmitted) {
          try {
            if (!navigated) {
              await wait(page.goto(workMode || imageMode ? this.origin : `${this.origin}/?temporary-chat=true`, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - this.now()) }));
              navigated = true;
              if (workMode) await wait(this.adapter.initializeWorkPage(page, { budget: Math.max(1, deadline - this.now()) }));
              if (imageMode) await wait(this.adapter.initializeImagePage(page, { budget: Math.max(1, deadline - this.now()) }));
            }
            await ensurePageError();
            const temporary = workMode || imageMode ? true : await wait(this.adapter.assertTemporaryChat(page));
            await ensurePageError();
            if (temporary !== true) throw new BackendError('temporary');
            await waitForOrdinaryReady();
            this.assertResult(await wait(this.adapter.readComposer(page)), command.model);
            this.assertResult(await wait(this.adapter.selectModel(page, command.model)), command.model);
            if (command.images?.length) this.assertResult(await wait(this.adapter.attachImages(page, command.images)), command.model);
            activeSignal.throwIfAborted();
            if (!run) {
              run = { id: randomUUID(), queue: [] };
              imageBaseline = imageMode ? await wait(page.locator('[data-testid="generated-image-preview"] img').evaluateAll(nodes => nodes.map(img => img.src))) : [];
            }
            this.turns.set(page, run);
            rememberCheckpoint();
            await startHarvest();
            const prompt = this.prompter(command, resumeFrom);
            const composer = page.locator(shape.composer).filter({ visible: true });
            await wait(composer.fill(prompt));
            activeSignal.throwIfAborted();
            if (this.adapter.submitPrompt) this.assertResult(await wait(this.adapter.submitPrompt(page, composer)), command.model);
            else await wait(composer.press('Enter'));
            promptSubmitted = true;
            rememberCheckpoint();
          } catch (error) {
            if (error?.code !== 'verification') throw error;
            await recoverChallenge();
          }
        }
        if (!harvestStarted) await startHarvest();
        for (;;) {
          try {
            if (imageMode) return await wait(this.adapter.readGeneratedImages(page, { baseline: imageBaseline, budget: Math.max(1, deadline - this.now()), artifactRoot: this.artifactRoot, signal: activeSignal }));
            return await wait(this.observe(page, { run, adapter: this.adapter, guard, budget: Math.max(0, deadline - this.now()), signal: activeSignal, emit: emitObservation }));
          } catch (error) {
            if (error?.code !== 'verification') throw error;
            await recoverChallenge();
            await wait(page.evaluate(({ id, network, model }) => window.__chatgptHarvest.start(id, network, model), {
              id: run.id, network: this.network && !command.visibleTurns && !workMode && !imageMode, model: wireModel,
            }));
          }
        }
      }, activeSignal, { visibleTurns: effectiveVisible, auth: command.auth, origin: this.origin }));
      activeSignal.throwIfAborted();
      if (!streamed) {
        await wait(emit({ type: 'delta', index: 0, text: result.text }));
      } else if (result.text.startsWith(streamedText) && result.text.length > streamedText.length) {
        await wait(emit({ type: 'delta', index: 0, text: result.text.slice(streamedText.length) }));
      }
      await wait(emit({ type: 'finish', reason: 'complete' }));
      activeSignal.throwIfAborted();
      delete binding.pendingChallenge;
      this.bindings.finish(binding, command, result.text, normalizeAssistantContent(command, result.text));
      return result;
    } catch (error) {
      let failure = error;
      if (!(failure instanceof BackendError)) {
        if (activeSignal.aborted) failure = activeSignal.reason instanceof BackendError ? activeSignal.reason : new BackendError('upstream');
        else if (error?.message === 'An active operation holds the browser context in the other mode. Wait for it to finish before switching modes.') failure = new BackendError('invalidRequest');
        else failure = new BackendError('upstream');
      }
      const cancelled = activeSignal.aborted && !deadlineExpired;
      const challengeFailure = !cancelled &&
        (preservePage || (challengeSeen && (deadlineExpired || failure.code === 'verification' || failure.code === 'truncated')));
      holdTurn = challengeFailure && Boolean(binding?.key);
      if (challengeFailure && failure.code !== 'expired' && failure.code !== 'cooldown' && failure.code !== 'browserClosed') {
        failure = new BackendError('verification');
      }
      if (holdTurn && binding) {
        binding.pendingChallenge = checkpoint ?? binding.pendingChallenge ?? { submitted: false };
        binding.busy = false;
        binding.used = this.now();
      } else {
        await stopPage();
        if (binding) await this.bindings.failed(binding);
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      activeSignal.removeEventListener('abort', abort);
      if (page) {
        this.turns.delete(page);
        if (!page.isClosed()) await page.evaluate(() => window.__chatgptHarvest?.stop()).catch(() => {});
      }
      if (binding && holdTurn && !page?.isClosed()) {
        binding.pendingChallenge = checkpoint ?? binding.pendingChallenge ?? { submitted: false };
        binding.busy = false;
        binding.used = this.now();
      } else if (binding && !holdTurn && !binding.key) await this.bindings.failed(binding);
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
      case 'model-unsupported': throw new BackendError('modelUnsupported', { values: { slug } });
      case 'model-not-offered': throw new BackendError('modelNotOffered', { values: { slug } });
      case 'attach-unavailable': throw new BackendError('attachmentUnsupported', { values: { kind: 'images without an upload control', maxCount: 4, maxBytes: '10 MiB' } });
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
