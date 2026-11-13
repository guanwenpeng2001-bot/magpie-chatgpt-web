import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNativeTurnToken } from '../src/native/runtime.mjs';

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
const format = /^turn_[0-9abcdefghjkmnpqrstvwxyz]{32}$/;

// Decode with BigInt independently of the encoder's rolling bit buffer. This
// checks every source bit, including leading zeros and the final five bits.
function decode(token) {
  assert.match(token, format);
  const value = [...token.slice(5)].reduce((number, char) => number * 32n + BigInt(alphabet.indexOf(char)), 0n);
  return Buffer.from(value.toString(16).padStart(40, '0'), 'hex');
}

test('turn capability preserves fixed 160-bit vectors in exactly 32 Crockford characters', () => {
  // Expected vectors independently obtained from RFC 4648 base32 with its
  // alphabet mapped by index to the lowercase Crockford alphabet.
  const vectors = [
    ['0000000000000000000000000000000000000000', '00000000000000000000000000000000'],
    ['ffffffffffffffffffffffffffffffffffffffff', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['000102030405060708090a0b0c0d0e0f10111213', '000g40r40m30e209185gr38e1w8124gk'],
    ['303132333435363738396162636465666768696a', '60rk4csm6mv3ee1sc5h66s35cskpgtba'],
  ];
  for (const [hex, payload] of vectors) {
    const bytes = Buffer.from(hex, 'hex');
    const before = Buffer.from(bytes);
    let calls = 0;
    const token = createNativeTurnToken(size => {
      calls++;
      assert.equal(size, 20);
      return bytes;
    });
    assert.equal(calls, 1);
    assert.equal(token, `turn_${payload}`);
    assert.equal(token.length, 37);
    assert.deepEqual(decode(token), before);
    assert.deepEqual(bytes, before, 'encoding must not mutate the random bytes');
  }
});

test('every one of the 160 source bits survives without truncation or aliasing', () => {
  const tokens = new Set();
  for (let bit = 0; bit < 160; bit++) {
    const bytes = Buffer.alloc(20);
    bytes[Math.floor(bit / 8)] = 1 << (7 - bit % 8);
    const token = createNativeTurnToken(() => bytes);
    assert.deepEqual(decode(token), bytes, `source bit ${bit}`);
    tokens.add(token);
  }
  assert.equal(tokens.size, 160);
});

test('the final character represents all five final random bits', () => {
  const prefix = 'turn_' + '0'.repeat(31);
  for (let tail = 0; tail < 32; tail++) {
    const bytes = Buffer.alloc(20);
    bytes[19] = tail;
    assert.equal(createNativeTurnToken(() => bytes), prefix + alphabet[tail]);
  }
});

test('fresh CSPRNG samples retain all bytes, stay in the native schema and do not repeat', () => {
  const tokens = new Set();
  for (let i = 0; i < 2048; i++) {
    let source;
    const token = createNativeTurnToken(size => {
      assert.equal(size, 20);
      source = randomBytes(size);
      return source;
    });
    assert.deepEqual(decode(token), source);
    assert.match(token, /^turn_[A-Za-z0-9_-]{32}$/, 'existing exact-format schema remains compatible');
    assert.doesNotMatch(token.slice(5), /[A-Zilou_-]/);
    assert.equal(tokens.has(token), false, 'fresh entropy must not produce a cached token');
    tokens.add(token);
  }
  assert.equal(tokens.size, 2048);
});

test('the helper remains self-contained when embedded by the runtime preload', () => {
  const embedded = new Function(`return (${createNativeTurnToken.toString()});`)();
  assert.equal(embedded(size => {
    assert.equal(size, 20);
    return Buffer.alloc(size, 0xff);
  }), 'turn_' + 'z'.repeat(32));
});
