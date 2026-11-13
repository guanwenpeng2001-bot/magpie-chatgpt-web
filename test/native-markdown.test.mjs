import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { compactionPreloadSource, nativeRoot } from '../src/native/runtime.mjs';

const pinnedHash = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = resolve(process.env.NATIVE_MARKDOWN_CLI
  ?? join(nativeRoot(), 'runtime-6.1.18/payload/app/cli.js'));

// Execute the production preload against bytes, without Bun, CLI startup,
// installation, a daemon, browser, network, or account/profile access.
async function preload(bytes, checksum = pinnedHash) {
  let onLoad;
  const script = compactionPreloadSource(entry)
    .replace("import { createHash } from 'node:crypto';", '')
    .replace("import { resolve } from 'node:path';", '')
    .replace(pinnedHash, checksum);
  runInNewContext(script, {
    createHash, resolve, Buffer, TextDecoder,
    Bun: {
      plugin({ setup }) { setup({ onLoad(_options, callback) { onLoad = callback; } }); },
      file(path) {
        assert.equal(path, entry);
        return { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
      },
    },
  });
  assert.equal(await onLoad({ path: join(entry, '../unrelated/cli.js') }), undefined);
  return onLoad({ path: entry });
}

function markdownModule(source) {
  // Evaluate only the pinned Markdown module, with its actual shipped packages.
  // Never import the CLI: its other top-level code can touch runtime state.
  const start = source.indexOf('var Vt=new hC(');
  const end = source.indexOf('var Wn=Xi,Ie=er;', start);
  assert.ok(start >= 0 && end > start, 'pinned Markdown module boundaries');
  const require = createRequire(entry);
  return runInNewContext(source.slice(start, end) + ';({ convert: CC, MarkdownBuffer: Rl })', {
    hC: require('turndown'),
    fC: require('turndown-plugin-gfm').gfm,
    gC: require('@mixmark-io/domino').createDocument,
  });
}

const rows = [
  ['测试项目', '结果', '实际结果'],
  ['空账单', '通过', '0'],
  ['单商品数量计算', '失败', '12，预期36'],
  ['多商品数量计算', '失败', '17，预期44'],
];
const invoiceTable = '<table><thead><tr>' + rows[0].map(s => `<th><p>${s}</p></th>`).join('')
  + '</tr></thead><tbody>' + rows.slice(1).map(row => '<tr>'
    + row.map(s => `<td><p>${s}</p></td>`).join('') + '</tr>').join('') + '</tbody></table>';
const expectedTable = [rows[0], ['---', '---', '---'], ...rows.slice(1)]
  .map(row => `| ${row.join(' | ')} |`).join('\n');

test('pinned Native Markdown regression (offline, read-only runtime)', async t => {
  let bytes;
  try { bytes = await readFile(entry); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.NATIVE_MARKDOWN_CLI) throw error;
    t.skip('pinned runtime absent; set NATIVE_MARKDOWN_CLI to an existing v6.1.18 app/cli.js (never downloads)');
    return;
  }
  assert.equal(digest(bytes), pinnedHash);
  const raw = bytes.toString('utf8');
  const before = markdownModule(raw);
  const patched = await preload(bytes);
  assert.equal(patched.loader, 'js');
  const after = markdownModule(patched.contents);

  await t.test('paragraph cells reproduce the live log and become one physical line per row', () => {
    // Exact table shape from native-live/cli-56-pro-turn1.log, not terminal wrapping.
    const broken = rows.map(row => '| ' + row.map(s => `\n\n${s}\n\n`).join(' | ') + ' |');
    broken.splice(1, 0, '| --- | --- | --- |');
    assert.equal(before.convert(invoiceTable), broken.join('\n').replace('| \n\n', '| \n'));
    assert.equal(after.convert(invoiceTable), expectedTable);
  });

  await t.test('div wrappers, multiple paragraphs, br and lists stay inside their cells', () => {
    const html = '<table><tr><th><div>标题</div></th><th>内容</th></tr><tr>'
      + '<td><p>第一段</p><p>第二段<br>第三行</p></td>'
      + '<td><ul><li>甲</li><li>乙</li></ul></td></tr></table>';
    assert.equal(after.convert(html), '| 标题 | 内容 |\n| --- | --- |\n'
      + '| 第一段<br>第二段<br>第三行 | - 甲<br>- 乙 |');
  });

  await t.test('inline formatting and code survive cell normalization', () => {
    const html = '<table><tr><th>内容</th></tr><tr><td><p><strong>粗体</strong> '
      + '<em>斜体</em> <a href="https://example.test/x">链接</a> <code>a  b</code>'
      + '</p></td></tr></table>';
    assert.equal(after.convert(html), '| 内容 |\n| --- |\n'
      + '| **粗体** *斜体* [链接](https://example.test/x) `a b` |');
  });

  await t.test('plain tables, empty cells, alignment and headerless HTML tables are unchanged', () => {
    for (const html of [
      '<table><tr><th align="left">A</th><th align="center">B</th><th align="right">C</th></tr>'
        + '<tr><td></td><td>value</td><td> </td></tr></table>',
      '<table><tr><td><p>no header</p></td><td><p>second</p></td></tr></table>',
    ]) assert.equal(after.convert(html), before.convert(html));
  });

  await t.test('paragraphs, lists, inline code and fenced code outside tables are byte-identical', () => {
    const prose = '<p>before<br>after</p><p><strong>next</strong></p><ul><li>one</li><li>two</li></ul>';
    const code = '<pre><code class="language-js">const x = `| \n\n cell\n\n |`;\n\n'
      + '// &lt;table&gt;&lt;td&gt;&lt;p&gt;literal&lt;/p&gt;&lt;/td&gt;&lt;/table&gt;\n</code></pre>';
    const inline = '<p><code>| literal |</code></p>';
    for (const html of [prose, code, inline, prose + code + invoiceTable + code]) {
      assert.equal(after.convert(html), before.convert(html).replace(before.convert(invoiceTable), expectedTable));
    }
  });

  await t.test('both streaming and complete buffers emit valid rows without duplicate text', () => {
    for (const delivery of ['stream', 'complete']) {
      const buffer = new after.MarkdownBuffer(undefined, 0, delivery);
      const segments = [{ key: 'table', tag: 'TABLE', html: invoiceTable, text: 'invoice', streamable: true }];
      const first = buffer.observe(segments, 0);
      const next = buffer.observe(segments, 1);
      const final = buffer.finish();
      assert.equal(final.markdown, expectedTable);
      assert.equal(first + next + final.delta, expectedTable);
      assert.equal(next, '');
    }
  });

  await t.test('checksum and missing or duplicate patch anchors fail closed', async () => {
    await assert.rejects(preload(Buffer.from(raw + '\n')), /runtime checksum mismatch/);
    const anchor = 'Vt.use(fC);';
    for (const replacement of ['', anchor + anchor]) {
      const drift = Buffer.from(raw.replace(anchor, replacement));
      // Override the hash in this test only to exercise the independent anchor guard.
      await assert.rejects(preload(drift, digest(drift)), /Native markdown table compatibility mismatch/);
    }
  });

  assert.deepEqual(await readFile(entry), bytes, 'installed CLI is never modified');
});
