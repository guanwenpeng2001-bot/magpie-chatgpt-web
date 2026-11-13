import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { NativeDaemon, writePrivate } from '../src/native/daemon.mjs';
import { CompactionService, compactionProxy } from '../src/native/compaction.mjs';

// Explicit opt-in: uses the durable installed release, never patches it or logs in.
// A missing Chrome executable stops exactly at the browser-worker launch boundary,
// making this smoke deterministic and offline with an empty scratch storage state.
test('installed 6.1.18 reaches read-only browser compaction without a launcher', {
  skip: process.env.NATIVE_COMPACTION_SMOKE !== '1', timeout: 60_000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-compaction-runtime-'));
  const payload = join(homedir(), '.config/magpie/chatgpt-web-native/runtime-6.1.18/payload');
  const runtimeCommand = [join(payload, 'runtime/bun.exe'), join(payload, 'app/cli.js')];
  let logs = '';
  let forcedStops = 0;
  const owner = new NativeDaemon({ home, runtimeCommand,
    chromeExecutablePath: join(home, 'intentionally-missing-chrome.exe'),
    storageState: async () => ({ cookies: [], origins: [] }), capabilities: { solAvailable: true },
    spawn(file, args, options) {
      const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = child.kill.bind(child);
      child.kill = (...args) => { forcedStops++; return kill(...args); };
      child.stdout.on('data', bytes => { logs += bytes; });
      child.stderr.on('data', bytes => { logs += bytes; });
      return child;
    },
  });
  const service = new CompactionService(owner, { writePrivate });
  t.after(async () => { await service.stop(); await rm(home, { recursive: true, force: true }); });
  await service.listen();
  const compact = compactionProxy(service.descriptor());
  const identity = { thread_id: 'offline-compaction-thread', turn_id: 'offline-compaction-turn' };
  for (const kind of ['v1', 'memento', 'v2']) {
    const metadata = { ...identity, turn_id: `${identity.turn_id}-${kind}`,
      ...(kind === 'memento' ? { request_kind: 'compaction',
        compaction: { implementation: 'responses', strategy: 'memento' } } : {}) };
    const body = { model: 'chatgpt-web/gpt-6-sol', stream: false,
      input: [{ type: 'message', id: 'offline-user', role: 'user', content: [{ type: 'input_text', text: 'Inspect the fixture project.' }],
        internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id, content_item_kinds: ['user_message'] } },
      ...(kind === 'v2' ? [{ type: 'compaction_trigger' }] : [])] };
    const response = await compact(body, { 'x-codex-turn-metadata': JSON.stringify(metadata) },
      AbortSignal.timeout(20_000), kind === 'v1' ? '/v1/responses/compact' : '/v1/responses');
    const text = await response.text();
    t.diagnostic(`${kind}: HTTP ${response.status} ${text}`);
    assert.match(text, /Configured Chrome executable does not exist/);
    assert.doesNotMatch(text + logs, /compaction_control_unavailable/);
  }
  const config = JSON.parse(await readFile(join(service.home, 'config.json'), 'utf8'));
  assert.equal(config.mode, 'browser-only');
  assert.equal(config.tunnel, undefined);
  assert.deepEqual(config.runtimeCommand, runtimeCommand);
  t.diagnostic(`spawned installed runtime with scratch CODEX_CHATGPT_WEB_HOME=${service.home}`);
  await service.stop();
  assert.equal(forcedStops, 0, 'reference admin shutdown should settle without forced termination');
});
