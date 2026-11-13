import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';
import { patchReferenceFixes } from '../src/native/reference-fixes.mjs';
import { prepareSubmissionReceipt, nativeUsageModel } from '../src/usage/submission.mjs';
import { readUsage } from '../src/usage/store.mjs';

test('pinned native Send callbacks persist separate multipart/final receipts, never observer duplicates',
  { skip: process.env.NATIVE_COMPACTION_SMOKE !== '1', timeout: 15000 }, async t => {
    const entry = join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js');
    const bytes = await readFile(entry); let onLoad;
    const preload = compactionPreloadSource(entry)
      .replace("import { createHash } from 'node:crypto';", '')
      .replace("import { resolve } from 'node:path';", '')
      .replace(`import { patchReferenceFixes } from ${JSON.stringify(new URL('../src/native/reference-fixes.mjs', import.meta.url).href)};`, '');
    runInNewContext(preload, { createHash, resolve, Buffer, TextDecoder, patchReferenceFixes,
      Bun: { plugin({ setup }) { setup({ onLoad(_filter, callback) { onLoad = callback; } }); },
        file() { return { arrayBuffer: async () => Uint8Array.from(bytes).buffer }; } } });
    const { contents } = await onLoad({ path: entry });
    const start = contents.indexOf('let magpieUsageIndex=0,magpieLegacyUsage=');
    const end = contents.indexOf(',Be=c.text,ze=[];', start);
    assert.ok(start > 0 && end > start);
    const source = contents.slice(start, end);
    const profile = await mkdtemp(join(tmpdir(), 'native-send-receipts-'));
    t.after(() => rm(profile, { recursive: true, force: true }));
    const accountKey = 'c'.repeat(64), writes = [], legacy = [];
    const create = new Function('prepareSubmissionReceipt', 'nativeUsageModel', 'process', 'os', 'O', 'Y', 'o', 'ho', 'rs', 'cn', 'e', 'm', 'c',
      `${source};return { next:ke,setMode(mode){Y=mode} };`);
    const factory = create.call({ config: { browserHostDescriptorPath: 'fixture-only' } },
      prepareSubmissionReceipt, nativeUsageModel, { env: { CODEX_CHATGPT_WEB_HOME: profile }, pid: 1 },
      async () => ({ accountKey }), {}, { modelFamily: '5.6', effort: 'low' }, false,
      () => 'legacy', () => true, async event => legacy.push(event), { traceId: 'fixture' }, writes, { multipart: { parts: [1, 2] } });
    const first = await factory.next();
    assert.equal((await readUsage({ profile, accountKey })).week, 0, 'preparing alone is not a send');
    first(); first();
    const second = await factory.next(); second();
    factory.setMode({ modelFamily: '6', effort: 'max' });
    const final = await factory.next(); final(); final();
    await Promise.all(writes);
    const usage = await readUsage({ profile, accountKey });
    assert.equal(usage.week, 3);
    assert.equal(usage.byStage.multipart.week, 2);
    assert.equal(usage.byStage.message.week, 1);
    assert.equal(usage.byModel.find(x => x.model === 'gpt-6-pro').week, 1);
    assert.equal(usage.byModel.find(x => x.model === 'gpt-5.6').week, 2);
    assert.deepEqual(legacy, [], 'automatic mode does not invent a Launcher endpoint');

    const compact = create.call({ config: {} }, prepareSubmissionReceipt, nativeUsageModel,
      { env: { CODEX_CHATGPT_WEB_HOME: profile }, pid: 1 }, async () => ({ accountKey }), {},
      { modelFamily: '6', effort: 'medium' }, false, () => 'legacy', () => true,
      async event => legacy.push(event), { traceId: 'compact', compaction: {} }, writes, {});
    const summarySent = await compact.next(); summarySent(); summarySent();
    await Promise.all(writes);
    const afterCompact = await readUsage({ profile, accountKey });
    assert.equal(afterCompact.week, 4);
    assert.equal(afterCompact.byStage.compaction.week, 1, 'a physical summary Send is counted once');
    assert.equal(afterCompact.byModel.find(x => x.model === 'gpt-6' && x.effort === 'medium').week, 1);
  });
