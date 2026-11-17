import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from './guard.mjs';
import { BrowserSupervisor, launchChatBrowserContext } from './browser.mjs';
import { Conversations } from './conversations.mjs';
import { installHarvest } from './harvest.mjs';
import * as siteAdapter from './site-adapter/index.mjs';
import { ADAPTER_VERSION, shape } from './site-adapter/selectors.mjs';
import { selectionPlans, wireModels, workSelectionPlans } from './site-adapter/compatibility.mjs';
import { IMAGE_MODEL } from './site-adapter/images.mjs';
import { observeTurn } from './observe.mjs';
import { compile } from './prompt.mjs';
import { normalizeAssistantContent, ToolParser } from '../src/tool-emulation.mjs';
import { prepareSubmissionReceipt } from '../src/usage/submission.mjs';
import { usageProfile } from '../src/usage/store.mjs';

const challengeText = new RegExp(shape.challengeCard, 'i');
const receiptCall = async (receipt, method) => {
  try { await receipt?.[method]?.(); } catch { /* Accounting never changes model execution. */ }
};

export class TurnDriver {
  constructor({ profileRoot, profile, artifactRoot, launch, origin = 'https://chatgpt.com', network = true, timeout = 180000, challengeTimeout = timeout, now = Date.now, adapter = siteAdapter, observe = observeTurn, prompter = compile, prepareReceipt = prepareSubmissionReceipt } = {}) {
    this.origin = origin;
    this.artifactRoot = artifactRoot ?? resolve(profileRoot ?? profile ?? '.', '..', 'chatgpt-web-artifacts');
    this.network = network;
    this.timeout = timeout;
    this.challengeTimeout = challengeTimeout;
    this.now = now;
    this.adapter = adapter;
    this.observe = observe;
    this.prompter = prompter;
    this.prepareReceipt = prepareReceipt;
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
    const workMode = Object.hasOwn(workSelectionPlans, command.model);
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
    const receiptRuns = new Set();
    const prepareRunReceipt = async run => {
      if (workMode || imageMode) return;
      receiptRuns.add(run);
      if (run.receiptPrepared) return run.receiptPreparation;
      run.receiptPrepared = true;
      run.receiptPreparation = (async () => {
        try {
          const model = command.selectionModel ?? command.model;
          const selectedEffort = selectionPlans[wireModels[model]?.uiModel ?? model]?.effort;
          run.receipt = await this.prepareReceipt({ page, profile: usageProfile(command.auth.profile),
            model, effort: { Instant: 'low', Medium: 'medium', High: 'high', 'Extra High': 'xhigh', Pro: 'max' }[selectedEffort]
              ?? command.reasoning?.effort ?? command.effort,
            stage: 'message', source: 'text', id: run.id });
        } catch { /* Missing identity or storage must not prevent a Send. */ }
      })();
      return run.receiptPreparation;
    };
    const confirmRun = (run, text) => {
      if (workMode || imageMode || !run?.receiptSubmitted || run.receiptAccepted ||
          typeof text !== 'string' || !text.trim() || challengeText.test(text)) return;
      // Acceptance precedes client-side envelope validation and delivery. Even a
      // malformed tool answer or a disconnected client consumed a physical Send.
      run.receiptAccepted = true;
      void receiptCall(run.receipt, 'confirm');
    };
    const confirmObservation = (run, observation) => {
      if (observation.event === 'dom' || observation.event === 'answer') confirmRun(run, observation.data?.text);
    };
    let streamedText = '';
    let observedText = '';
    const emitObservation = async observation => {
      let next;
      if (observation.event === 'dom' && typeof observation.data?.text === 'string') next = observation.data.text;
      else if (observation.event === 'answer' && typeof observation.data?.text === 'string') next = observedText + observation.data.text;
      else return;
      if (challengeText.test(next)) return;
      observedText = next;
      // The client cannot retract text. Hold every envelope (including a split
      // opening marker) until the canonical final answer has been validated.
      if (command.tools?.length) {
        const parser = new ToolParser(command);
        const marker = next.indexOf(command.start);
        parser.feed(marker >= 0 ? next.slice(0, marker + command.start.length) : next);
        next = marker >= 0 ? next.slice(0, marker) : next.slice(0, next.length - parser.buffer.length);
      }
      if (!next.startsWith(streamedText)) throw new BackendError('protocol');
      const delta = next.slice(streamedText.length);
      if (!delta) return;
      streamedText = next;
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
        if (run?.receiptPrepared) receiptRuns.add(run);
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
          run.networkExpected = this.network && !command.visibleTurns && !workMode && !imageMode;
          this.turns.set(page, run);
          await wait(page.evaluate(({ id, network, model }) => window.__chatgptHarvest.start(id, network, model), {
            id: run.id, network: this.network && !command.visibleTurns && !workMode && !imageMode, model: wireModel,
          }));
          harvestStarted = true;
        };
        const repairIncompleteAction = async result => {
          if (!command.tools?.length || typeof command.start !== 'string' || typeof command.end !== 'string' ||
              command.toolChoice?.type === 'none' ||
              typeof result?.text !== 'string') return undefined;
          const parser = new ToolParser(command);
          parser.feed(result.text);
          if (!parser.inside || parser.jsonEnd >= 0) return undefined;
          const prefix = result.text.slice(0, result.text.length - parser.buffer.length - command.start.length);
          const names = (command.promptTools ?? command.tools).map(tool => tool.name).join(', ');
          for (let attempt = 0; attempt < 2; attempt++) {
            activeSignal.throwIfAborted();
            run = { id: randomUUID(), queue: [] };
            await startHarvest();
            await ensurePageError();
            await waitForOrdinaryReady();
            this.assertResult(await wait(this.adapter.readComposer(page)), command.model);
            const composer = page.locator(shape.composer).filter({ visible: true });
            await wait(composer.fill([
              'Your previous answer stopped inside a client-action envelope and omitted the required JSON or left it incomplete.',
              'Do not repeat or explain that marker.',
              'Reply now with only one JSON object using one action listed earlier and matching its input_schema.',
              `The allowed action names are: ${names}.`,
              attempt ? 'Return the JSON object itself, starting with { and ending with }.' : 'Use no prose, Markdown, code fence or closing delimiter.',
              'If no action is needed, reply exactly NO_ACTION.',
            ].join('\n')));
            await wait(prepareRunReceipt(run));
            activeSignal.throwIfAborted();
            if (this.adapter.submitPrompt) this.assertResult(await wait(this.adapter.submitPrompt(page, composer)), command.model);
            else await wait(composer.press('Enter'));
            run.receiptSubmitted = true;
            promptSubmitted = true;
            rememberCheckpoint();
            let repair;
            const repairRun = run;
            try {
              repair = await wait(this.observe(page, {
                run,
                adapter: this.adapter,
                guard,
                budget: Math.max(0, deadline - this.now()),
                signal: activeSignal,
                emit: async observation => { confirmObservation(repairRun, observation); },
              }));
              confirmRun(repairRun, repair?.text);
            } catch (error) {
              if (activeSignal.aborted) throw error;
              if (['expired', 'cooldown', 'verification', 'browserClosed'].includes(error?.code)) throw error;
              continue;
            }
            const text = typeof repair?.text === 'string' ? repair.text.trim() : '';
            const first = text.indexOf('{');
            const last = text.lastIndexOf('}');
            if (first < 0 || last <= first) continue;
            const candidate = `${prefix}${command.start}${text.slice(first, last + 1)}${command.end}`;
            try {
              normalizeAssistantContent(command, candidate);
            } catch {
              continue;
            }
            return { ...result, text: candidate, route: repair.route ?? result.route, repaired: true };
          }
          return undefined;
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
            this.assertResult(
              await wait(this.adapter.selectModel(page, command.selectionModel ?? command.model)),
              command.selectionModel ?? command.model,
            );
            const images = (command.images ?? []).filter((image, index) =>
              resumeFrom === 0 || (command.imageHistoryIndices?.[index] ?? Infinity) >= resumeFrom);
            if (images.length) this.assertResult(await wait(this.adapter.attachImages(page, images)), command.model);
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
            await wait(prepareRunReceipt(run));
            activeSignal.throwIfAborted();
            if (this.adapter.submitPrompt) this.assertResult(await wait(this.adapter.submitPrompt(page, composer)), command.model);
            else await wait(composer.press('Enter'));
            run.receiptSubmitted = true;
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
            const observedRun = run;
            const first = await wait(this.observe(page, { run, adapter: this.adapter, guard, budget: Math.max(0, deadline - this.now()), signal: activeSignal,
              emit: observation => { confirmObservation(observedRun, observation); return emitObservation(observation); } }));
            confirmRun(observedRun, first?.text);
            const repaired = await wait(repairIncompleteAction(first));
            return repaired ?? first;
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
      const assistantContent = normalizeAssistantContent(command, result.text);
      if (!result.text.startsWith(streamedText)) throw new BackendError('protocol');
      if (result.text.length > streamedText.length) {
        await wait(emit({ type: 'delta', index: 0, text: result.text.slice(streamedText.length) }));
      }
      await wait(emit({ type: 'finish', reason: 'complete' }));
      activeSignal.throwIfAborted();
      delete binding.pendingChallenge;
      this.bindings.finish(binding, command, result.text, assistantContent);
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
      for (const run of receiptRuns) {
        if (run.receiptSubmitted && !run.receiptAccepted && !run.receiptUncertain) {
          run.receiptUncertain = true;
          void receiptCall(run.receipt, 'uncertain');
        }
      }
      // The helper owns bounded flushing; neither write errors nor rejected
      // optional callbacks may turn a completed answer into a retry.
      await Promise.all([...receiptRuns].map(run => receiptCall(run.receipt, 'flush')));
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
