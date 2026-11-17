import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';

const pinnedHash = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = resolve(process.env.NATIVE_TERMINAL_CLI
  ?? join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js'));
const executablePath = process.env.NATIVE_TERMINAL_BROWSER || process.env.CHATGPT_DOM_TEST_BROWSER;

// Execute the real preload against pinned bytes. Never import/start the CLI,
// install anything, connect over CDP, or access account/profile/config files.
async function preload(bytes, checksum = pinnedHash) {
  let onLoad;
  const script = compactionPreloadSource(entry)
    .replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '')
    .replace(`import { patchReferenceFixes } from ${JSON.stringify(new URL('../src/native/reference-fixes.mjs', import.meta.url).href)};`, '')
    .replace(pinnedHash, checksum);
  runInNewContext(script, {
    createHash, resolve, Buffer, TextDecoder, patchReferenceFixes,
    Bun: {
      plugin({ setup }) { setup({ onLoad(_options, callback) { onLoad = callback; } }); },
      file(path) {
        assert.equal(path, entry);
        return { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
      },
    },
  });
  assert.equal(typeof onLoad, 'function');
  assert.equal(await onLoad({ path: join(entry, '../unrelated/cli.js') }), undefined);
  return onLoad({ path: entry });
}

function terminalFunction(source) {
  const anchor = 'async function wf(e){';
  assert.equal(source.split(anchor).length, 2, 'unique pinned wf entry');
  const start = source.indexOf(anchor);
  const end = source.indexOf('async function bf(e,t){', start);
  assert.ok(end > start, 'pinned terminal/delivery function boundary');
  return source.slice(start, end);
}

class FakeAdapterError extends Error {
  constructor(message, options) { super(message); Object.assign(this, options); }
}

function patchedDetector(source) {
  const wf = terminalFunction(source);
  assert.equal(wf, 'async function wf(e){return nativeTerminalErrorAlert(e,q)}');
  const anchor = 'async function nativeTerminalErrorAlert(';
  assert.equal(source.split(anchor).length, 2, 'one helper appended by real preload');
  const start = source.indexOf(anchor);
  const nextImport = source.indexOf('import { checkpointStore', start);
  assert.ok(nextImport > start, 'appended helper ends before checkpoint import');
  const end = source.lastIndexOf('}', nextImport) + 1;
  assert.ok(end > start);
  // Both wf and helper come from patched.contents, not a direct helper import
  // or a copied detector. Only the error constructor is replaced for isolation.
  return runInNewContext(source.slice(start, end) + '\n' + wf + '\nwf', {
    q: FakeAdapterError,
  });
}

const messages = ['消息流中的错误', '出了点问题。请重试'];
const user = '<div data-user-message-bubble>Fixture prompt</div>';
const alert = (message = messages[0]) => `<aside role="alert">${message}<button>重试</button></aside>`;
const retry = '<button data-testid="regenerate-thread-error-button">Retry</button>';
const genericAlert = `<aside role="alert">Service failure${retry}</aside>`;
const current = html => `<section data-turn-key="current">${user}${html}</section>`;

test('pinned Native terminal alert preload and DOM regressions', async t => {
  let bytes;
  try { bytes = await readFile(entry); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_TERMINAL_CLI) throw error;
    t.skip('pinned runtime absent; set NATIVE_TERMINAL_CLI to an existing v6.1.18 app/cli.js (never downloads)');
    return;
  }
  assert.equal(digest(bytes), pinnedHash);
  const raw = bytes.toString('utf8');
  const patched = await preload(bytes);
  assert.equal(patched.loader, 'js');
  const detect = patchedDetector(patched.contents);

  await t.test('checksum and missing or duplicate terminal anchors fail closed', async () => {
    await assert.rejects(preload(Buffer.from(raw + '\n')), /runtime checksum mismatch/);
    const anchor = terminalFunction(raw);
    assert.equal(anchor.length, 528);
    for (const replacement of ['', anchor + anchor]) {
      const drift = Buffer.from(raw.replace(anchor, replacement));
      // Test-only hash substitution reaches the independent anchor guard.
      await assert.rejects(preload(drift, digest(drift)), /Native terminal alert compatibility mismatch/);
    }
  });

  await t.test('actual patched wf detects only visible bound service alerts', {
    skip: !executablePath && 'set NATIVE_TERMINAL_BROWSER (or CHATGPT_DOM_TEST_BROWSER) to installed Chrome',
  }, async dom => {
    const { chromium } = createRequire(entry)('playwright-core');
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      async function check(html, shouldFail, selector = '[data-turn-key="current"]') {
        await page.setContent(html);
        const operation = detect(page.locator(selector));
        if (shouldFail) await assert.rejects(operation, error => {
          assert.ok(error instanceof FakeAdapterError);
          assert.equal(error.status, 502);
          assert.equal(error.errorType, 'server_error');
          assert.equal(error.code, 'upstream_server_error');
          assert.equal(error.retryable, true);
          return true;
        });
        else assert.equal(await operation, undefined);
      }

      for (const message of messages) {
        await dom.test(`grouped Chinese alert without assistant body: ${message}`, () => check(current(alert(message)), true));
        await dom.test(`article Chinese alert without assistant body: ${message}`, () => check(
          `<article data-turn-id="current" data-turn="assistant">${alert(message)}</article>`, true, '[data-turn-id="current"]'));
      }
      for (const message of ['Error in message stream', 'Something went wrong. Please try again.', 'Something went wrong. Please retry.', 'Something went wrong. If this issue persists please contact us through our help center at help.openai.com.']) {
        await dom.test(`English service alert: ${message}`, () => check(
          current(`<aside role="alert">${message}<button>Retry</button></aside>`), true));
      }
      await dom.test('unknown service error with dedicated retry inside guarded alert', () => check(current(genericAlert), true));

      const excluded = [
        ['plain body', `<div>${messages[0]}</div>`],
        ['markdown alert', `<div class="markdown">${alert()}</div>`],
        ['markdown root alert', `<aside class="markdown" role="alert">${messages[0]}</aside>`],
        ['new markdown wrapper', `<div data-markdown-text-style="assistant-message">${alert()}</div>`],
        ['user bubble', `<div data-user-message-bubble>${alert()}</div>`],
        ['user author', `<div data-message-author-role="user">${alert()}</div>`],
        ['user conversation role', `<div data-conversation-role="user">${alert()}</div>`],
        ['editor', `<div contenteditable="true">${alert()}</div>`],
        ['empty contenteditable', `<div contenteditable>${alert()}</div>`],
        ['hidden ancestor', `<div hidden>${alert()}</div>`],
        ['inert ancestor', `<div inert>${alert()}</div>`],
        ['aria hidden ancestor', `<div aria-hidden="true">${alert()}</div>`],
        ['display none ancestor', `<div style="display:none">${alert()}</div>`],
        ['visibility hidden ancestor', `<div style="visibility:hidden">${alert()}</div>`],
        ['opacity zero ancestor', `<div style="opacity:0">${alert()}</div>`],
        ['zero sized alert', `<aside role="alert" style="width:0;height:0;overflow:hidden">${messages[0]}</aside>`],
        ['foreign grouped turn', `<section data-turn-key="foreign">${alert()}</section>`],
        ['foreign article turn', `<article data-turn-id="foreign">${alert()}</article>`],
        ['quoted alert', alert(`示例：${messages[0]}`)],
        ['unrelated alert', alert('连接成功')],
        ['unrelated retry button', '<button>重试</button>'],
        ['English markdown quote', '<div class="markdown"><p>Something went wrong. See help.openai.com</p></div>'],
        ['English plain body', '<p>Something went wrong. See help.openai.com</p>'],
        ['English quoted alert', '<aside role="alert">Example: Error in message stream</aside>'],
        ['dedicated retry outside alert', retry],
        ['retry testid inside markdown', `<div class="markdown">${retry}</div>`],
        ['generic service alert inside markdown', `<div class="markdown">${genericAlert}</div>`],
        ['generic service alert inside user', `<div data-message-author-role="user">${genericAlert}</div>`],
        ['markdown retry nested inside alert', `<aside role="alert">Example<div class="markdown">${retry}</div></aside>`],
        ['user retry nested inside alert', `<aside role="alert">Example<div data-message-author-role="user">${retry}</div></aside>`],
        ['hidden retry inside alert', `<aside role="alert">Example<div hidden>${retry}</div></aside>`],
      ];
      for (const [name, html] of excluded) {
        await dom.test(`ignore ${name}`, () => check(current(html), false));
      }
      await dom.test('ignore history and unbound page alert', () => check(
        `<section data-turn-key="old">${user}${alert()}</section>${current('')}${alert()}`, false));
      await dom.test('ignore alert before current user', () => check(
        `<section data-turn-key="current">${alert()}${user}</section>`, false));
      await dom.test('ignore duplicate bound containers', () => check(current(alert()) + current(''), false));
      await dom.test('ignore missing bound container', () => check(alert(), false));
      await dom.test('later hidden alert cannot mask visible alert', () => check(current(alert() + `<div hidden>${alert()}</div>`), true));
    } finally { await browser.close(); }
  });
  assert.deepEqual(await readFile(entry), bytes, 'installed CLI remains byte-identical');
});
