import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMagpieSummary } from '../src/native/summary-envelope.mjs';

test('Magpie summary transport preserves exact UTF-8 including BOM, newlines and non-ASCII', () => {
  for (const text of ['Completed command; only reply remains.', '\ufeff已完成\r\n测试 ✅\n', '  spaces  ', '']) {
    assert.equal(decodeMagpieSummary('magpie1:' + Buffer.from(text).toString('base64')), text);
  }
});

test('unrelated, malformed, noncanonical and non-UTF8 envelopes remain opaque', () => {
  for (const value of [null, {}, 'ocx1:dGVzdA==', 'encrypted-opaque', 'MAGPIE1:dGVzdA==',
    'magpie1:%%%', 'magpie1:dGVzdA', 'magpie1:dGVzdA===', 'magpie1:dGVzdA==\n',
    'magpie1:dGVzdB==', 'magpie1:/w==']) assert.equal(decodeMagpieSummary(value), null);
});
