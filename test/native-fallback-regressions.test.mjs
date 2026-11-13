import test from 'node:test';
import assert from 'node:assert/strict';
import { toTextRequest } from '../src/native/fallback.mjs';
import { makeLoader } from '../src/loader.mjs';
import { parseSSE } from '../src/wire/sse.mjs';

const choices = [
  { label: 'omitted', source: undefined, expected: { type: 'auto' } },
  { label: 'auto', source: 'auto', expected: { type: 'auto' } },
  { label: 'required', source: 'required', expected: { type: 'any' } },
  { label: 'function', source: { type: 'function', name: 'run' }, expected: { type: 'tool', name: 'run' } },
  { label: 'namespace function', source: { type: 'function', namespace: 'functions', name: 'run' }, expected: { type: 'tool', name: 'functions.run' } },
  { label: 'custom', source: { type: 'custom', name: 'run' }, expected: { type: 'tool', name: 'run' } },
  { label: 'none', source: 'none', expected: { type: 'none' } },
];
const bodyFor = (choice, parallel) => ({
  model: 'native/fallback-test/gpt-6', input: 'Inspect the fixture.',
  tools: [{ type: choice.source?.type === 'custom' ? 'custom' : 'function', name: 'run',
    ...(choice.source?.namespace ? { namespace: choice.source.namespace } : {}), parameters: { type: 'object' } }],
  ...(choice.source === undefined ? {} : { tool_choice: choice.source }),
  ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }),
});

for (const slug of ['gpt-5.6-pro', 'gpt-6-pro']) {
  for (const effort of [undefined, 'high', 'max']) test(`${slug} text conversion retains max despite ${effort ?? 'absent'} effort`, () => {
    const body = { model: `native/fallback-test/${slug}`, input: 'Masked {{PATH_ab12cd34}}.',
      ...(effort ? { reasoning: { effort } } : {}) };
    const before = structuredClone(body);
    const request = toTextRequest(body);
    assert.equal(request.reasoning_effort, 'max');
    assert.equal(request.model, slug === 'gpt-6-pro' ? 'gpt-6' : 'gpt-5-6');
    assert.deepEqual(body, before);
  });
}

for (const choice of choices) for (const parallel of [false, true, undefined]) {
  test(`Responses conversion preserves ${choice.label} with parallel=${parallel}`, () => {
    const body = bodyFor(choice, parallel);
    const before = structuredClone(body);
    const converted = toTextRequest(body);
    assert.deepEqual(converted.tool_choice, parallel === false
      ? { ...choice.expected, disable_parallel_tool_use: true }
      : choice.source === undefined ? undefined : choice.expected);
    assert.deepEqual(body, before);
    assert.equal(toTextRequest(body, true).tool_choice, undefined);
    assert.deepEqual(toTextRequest(body, true).tools, []);
  });
}

for (const choice of choices.filter(choice => choice.label !== 'none')) {
  for (const stream of [false, true]) for (const parallel of [false, true, undefined]) {
    test(`Responses fallback ${choice.label} rejects double tools only when parallel=false (parallel=${parallel}, stream=${stream})`, async () => {
      let submissions = 0;
      let closed = false;
      let nativeLookups = 0;
      const loader = await makeLoader({ native: { runtime: async () => {
        nativeLookups++;
        return { health: async () => true, responses: async () => Response.json({ output: [] }) };
      } }, bridge: { async open(command) {
        submissions++;
        const name = choice.expected.name ?? 'run';
        const input = choice.source?.type === 'custom' ? { input: 'fixture' } : {};
        const call = `${command.start}${JSON.stringify({ name, input })}${command.end}`;
        const upstream = (async function* () {
          yield { type: 'delta', index: 0, text: call };
          yield { type: 'delta', index: 0, text: call };
          yield { type: 'finish', reason: 'complete' };
        })();
        upstream.close = () => { closed = true; };
        return upstream;
      } } })(async () => ({ type: 'oauth', refresh: 'fixture', profile: 'fallback-test' }));
      const response = await loader.fetch('http://127.0.0.1:1/v1/responses', {
        body: JSON.stringify({ ...bodyFor(choice, parallel), stream }),
      });
      assert.equal(submissions, 1);
      assert.equal(nativeLookups, 0, 'unproven tool calls must bypass native');
      assert.equal(closed, true);
      if (parallel === false) {
        assert.equal(response.status, 502);
        assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
        const result = await response.json();
        assert.equal(result.error.code, 'toolParallel');
        assert.equal(result.output, undefined, 'no partial tool response escapes');
      } else {
        assert.equal(response.status, 200);
        const result = stream
          ? parseSSE(await response.text()).events.map(event => JSON.parse(event.data)).find(event => event.type === 'response.completed').response
          : await response.json();
        assert.equal(result.output.length, 2);
        assert.ok(result.output.every(item => item.type === (choice.source?.type === 'custom' ? 'custom_tool_call' : 'function_call')));
      }
    });
  }
}
