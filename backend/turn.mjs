import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendError } from './guard.mjs';
import { responseFailure } from './http.mjs';
import { BrowserSupervisor, launchSignInBrowser } from './browser.mjs';
import { Conversations } from './conversations.mjs';
import { installHarvest } from './harvest.mjs';
import { AnswerStream } from '../src/protocol.mjs';

export class TurnDriver {
  constructor({ profileRoot, profile, launch, origin = 'https://chatgpt.com', network = true, timeout = 180000, now } = {}) {
    this.origin = origin;
    this.network = network;
    this.timeout = timeout;
    this.bindings = new Conversations({ now });
    this.browser = new BrowserSupervisor({ profileRoot, profile, launch: launch ?? (async profile => {
      const owned = await launchSignInBrowser(profile, new AbortController().signal);
      const context = owned.context;
      context.close = owned.close;
      return context;
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
    const release = await guard.begin(signal);
    let binding;
    try {
      binding = await this.bindings.take(command, identity);
      binding.busy = true;
      await this.browser.run(command.auth.profile, async context => {
        await this.install(context);
        signal.throwIfAborted();
        let page = binding.page;
        const fresh = !page || page.isClosed();
        if (fresh) { page = await context.newPage(); binding.page = page; }
        const abort = () => { page.close().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          if (fresh) {
            await page.goto(`${this.origin}/?temporary-chat=true`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (new URL(page.url()).searchParams.get('temporary-chat') !== 'true') throw new BackendError('temporary');
          }
          await this.pageError(page, guard);
          const composer = page.getByRole('textbox').filter({ visible: true });
          await composer.first().waitFor({ state: 'visible', timeout: 30000 });
          if (await composer.count() !== 1) throw new BackendError('pageShape');
          await this.selectModel(page, command.model);
          const id = randomUUID();
          const turn = { id, queue: [] };
          this.turns.set(page, turn);
          await page.evaluate(({ id, network }) => window.__chatgptHarvest.start(id, network), { id, network: this.network });
          signal.throwIfAborted();
          await composer.fill(command.prompt);
          signal.throwIfAborted();
          await composer.press('Enter');
          const answer = new AnswerStream();
          let fallback = false;
          let sawStop = false;
          let eof = false;
          let observationFailure = null;
          const started = Date.now();
          while (Date.now() - started < this.timeout) {
            signal.throwIfAborted();
            if (page.isClosed()) throw new BackendError('browserClosed');
            await this.pageError(page, guard);
            if (turn.failure) throw turn.failure;
            for (const item of turn.queue.splice(0)) {
              if (item.kind === 'status' && item.status !== 200) {
                throw responseFailure(item.status, item, guard, item.retryAfter);
              }
              if (item.kind === 'failure') {
                if (item.code === 'upstream') {
                  const upstream = new BackendError(item.code);
                  if (item.cause) upstream.cause = item.cause;
                  throw upstream;
                }
                // 'harvest' and 'protocol' reader failures describe the
                // observation route, not the turn: the DOM fallback can still
                // complete the answer, so the turn stays alive and records why.
                if (item.code !== 'harvest' && item.code !== 'protocol') throw new BackendError(item.code);
                observationFailure ??= new BackendError(item.code);
                if (item.cause) observationFailure.cause ??= item.cause;
                fallback = true;
              }
              if (item.kind === 'fallback') {
                if (answer.text) throw new BackendError('harvest');
                fallback = true;
              }
              if (item.kind === 'frame') {
                let data;
                try { data = item.frame.data === '[DONE]' ? '[DONE]' : JSON.parse(item.frame.data); }
                catch { throw new BackendError('protocol'); }
                const frame = { event: item.frame.event, data };
                const delta = answer.accept(frame);
                fallback ||= answer.handedOff;
                if (delta) await emit({ event: 'answer', data: { text: delta } });
              }
              if (item.kind === 'eof') { eof = true; if (item.partial) throw new BackendError('truncated'); }
            }
            if (fallback) {
              const snapshot = await page.evaluate(() => window.__chatgptHarvest.snapshot());
              await this.pageError(page, guard);
              if (snapshot.failed) {
                observationFailure ??= new BackendError('harvest');
                observationFailure.cause ??= typeof snapshot.failed === 'string' ? snapshot.failed : 'the page reader reported a failure';
              }
              sawStop ||= snapshot.stop;
              const frame = { event: 'dom', data: { text: snapshot.text, complete: snapshot.finished && !snapshot.stop && sawStop } };
              const delta = answer.accept(frame);
              if (delta) await emit({ event: 'dom', data: { text: answer.text } });
            }
            if (answer.complete) {
              answer.finish();
              await emit({ event: '', data: { type: 'message_stream_complete' } });
              binding.conversationUrl = /^\/c\/[^/]+$/.test(new URL(page.url()).pathname) ? page.url() : undefined;
              this.bindings.finish(binding, command, answer.text);
              return;
            }
            if (eof && !fallback) throw new BackendError('truncated');
            await delay(50, undefined, { signal });
          }
          const expired = new BackendError('truncated');
          if (observationFailure) expired.cause = observationFailure.cause ? `${observationFailure.code}: ${observationFailure.cause}` : observationFailure.code;
          throw expired;
        } finally {
          signal.removeEventListener('abort', abort);
          this.turns.delete(page);
          await page.evaluate(() => window.__chatgptHarvest?.stop()).catch(() => {});
        }
      }, signal);
    } catch (error) {
      if (binding) {
        if (error instanceof BackendError && error.code === 'verification') binding.page = undefined;
        await this.bindings.failed(binding);
      }
      throw error instanceof BackendError ? error : new BackendError(signal.aborted ? 'upstream' : 'pageShape');
    } finally {
      if (binding && !binding.key) await this.bindings.failed(binding);
      release();
    }
  }
  async pageError(page, guard) {
    const state = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alert"]')].map(node => node.innerText).join('\n');
      const challengeCard = [...document.querySelectorAll('[data-content-search-unit-key$=":assistant"], [data-dil-message-id], [data-message-author-role="assistant"], [aria-label="Assistant response"], [role="alert"]')].some(node => /(?:^|\n)\s*cloudflare_challenge\s*(?:\n|$)/.test(node.innerText));
      return {
        rate: /usage limit|rate limit|reached.*limit|too many requests|使用上限|达到.*上限|请求过多|limite.*atteinte|límite.*alcanzado|Limit.*erreicht|limite.*atingido|上限に達|한도.*도달/i.test(dialogs),
        challenge: challengeCard || [...document.querySelectorAll('iframe')].some(node => /challenge|captcha/i.test(node.title ?? '')) || /verify you are human|验证您是真人|请完成验证/i.test(dialogs) || /just a moment|请稍候/i.test(document.title),
        expired: [...document.querySelectorAll('button')].some(node => /^(log in|sign in|登录)$/i.test(node.innerText.trim())) && !document.querySelector('[contenteditable="true"], textarea'),
      };
    });
    if (state.rate) throw new BackendError('cooldown', { retryAfter: guard.observe(429) });
    if (state.challenge) throw new BackendError('verification');
    if (state.expired) { guard.observe(401); throw new BackendError('expired'); }
  }
  async selectModel(page, slug) {
    if (slug === 'auto') return;
    const machine = page.locator('[data-model-id]').filter({ visible: true });
    for (const item of await machine.all()) {
      if (await item.getAttribute('data-model-id') === slug) { await item.click(); return; }
    }
    const picker = page.locator('button[data-codex-intelligence-trigger="true"][aria-haspopup="menu"][data-composer-navigation-target="reasoning"]').filter({ visible: true });
    try { await picker.first().waitFor({ state: 'visible', timeout: 10000 }); }
    catch { throw new BackendError('pageShape'); }
    if (await picker.count() !== 1) throw new BackendError('pageShape');
    await picker.click();
    try {
      const menu = page.locator('[role="menu"]').filter({ visible: true });
      try { await menu.first().waitFor({ state: 'visible', timeout: 10000 }); }
      catch { throw new BackendError('pageShape'); }
      const modelView = page.locator('[role="menu"] [role="menuitem"][data-model-picker-view-toggle="true"]').filter({ visible: true });
      if (await page.getByRole('menuitemradio').filter({ visible: true }).count() === 0) {
        if (await modelView.count() === 1) await modelView.click();
        const rendered = page.getByRole('menuitemradio').filter({ visible: true });
        if (await rendered.count() === 0) {
          try { await rendered.first().waitFor({ state: 'visible', timeout: 5000 }); }
          catch { throw new BackendError('pageShape'); }
        }
      }
      // Localized server-rendered titles are a fallback, not structural anchors.
      // GPT-6 and GPT-5.5 are unique-title mappings against the archived picker.
      // Selection and submission were measured; answer provenance was not, so no
      // mapping carries a generation claim. Mini variants and the catalogue's
      // Luna versus the picker's Sol are unmapped.
      const labels = { 'gpt-6': 'GPT-6', 'gpt-5-5': 'GPT-5.5' };
      const entries = page.getByRole('menuitemradio').filter({ visible: true });
      const matches = [];
      for (const entry of await entries.all()) {
        const id = await entry.getAttribute('data-model-id');
        const title = (await entry.innerText()).split('\n')[0].trim();
        if (id === slug || (!id && labels[slug] === title)) matches.push(entry);
      }
      if (matches.length === 1) { await matches[0].click(); return; }
      throw new BackendError('pageShape');
    } finally { await page.keyboard.press('Escape'); }
  }
  async close() { await this.bindings.close(); await this.browser.close(); }
}
