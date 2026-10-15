import { randomUUID } from 'node:crypto';
import { BackendError } from '../../backend/guard.mjs';
import { ToolParser } from '../tool-emulation.mjs';
import { errors } from '../errors.mjs';
import { parseSSE, encodeSSE } from './sse.mjs';

const event = value => encodeSSE({ event: value.type, data: value });

export async function* translate(source, prepared) {
  const parser = prepared.tools?.length ? new ToolParser(prepared) : null;
  const choice = prepared.toolChoice ?? prepared.choice;
  let index = 0, textOpen = false, calls = 0, outputChars = 0, complete = false, usage, visibleText = false;
  yield event({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: prepared.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: Math.ceil((prepared.prompt?.length ?? JSON.stringify(prepared.history ?? []).length) / 4), output_tokens: 0 } } });
  function* emit(items) {
    for (const item of items) {
      if (item.text) {
        if (!textOpen) { yield event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); textOpen = true; }
        visibleText ||= !!item.text.trim();
        outputChars += [...item.text].length;
        yield event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: item.text } });
      } else if (item.tool) {
        if (++calls > 1 && choice.disable_parallel_tool_use) throw new BackendError('toolParallel');
        if (textOpen) { yield event({ type: 'content_block_stop', index: index++ }); textOpen = false; }
        const { input, ...block } = item.tool;
        const json = JSON.stringify(input);
        outputChars += [...json].length;
        yield event({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        yield event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } });
        yield event({ type: 'content_block_stop', index: index++ });
      }
    }
  }
  for await (const frame of source) {
    if (!frame || complete || !['delta', 'finish', 'error'].includes(frame.type)) throw new BackendError('protocol');
    if (frame.type === 'error') {
      if (!Object.hasOwn(errors, frame.code) || typeof frame.message !== 'string') throw new BackendError('protocol');
      const failure = new BackendError(frame.code);
      failure.code = frame.code;
      failure.status = errors[frame.code].status;
      failure.message = frame.message;
      const envelope = { status: failure.status, message: failure.message };
      if (failure.signIn) envelope.signIn = failure.signIn;
      if (failure.retryAfter) envelope.retryAfter = failure.retryAfter;
      failure.toJSON = () => ({ ...envelope });
      throw failure;
    }
    if (frame.type === 'finish') {
      if (!['complete', 'truncated'].includes(frame.reason)) throw new BackendError('protocol');
      if (frame.reason === 'truncated') throw new BackendError('truncated');
      if (frame.usage !== undefined && (!Number.isSafeInteger(frame.usage?.output_tokens) || frame.usage.output_tokens < 0)) throw new BackendError('protocol');
      complete = true;
      usage = frame.usage;
    } else {
      if (!Number.isSafeInteger(frame.index) || frame.index < 0 || typeof frame.text !== 'string') throw new BackendError('protocol');
      if (frame.text) yield* emit(parser ? parser.items(frame.text) : [{ text: frame.text }]);
    }
  }
  if (!complete) throw new BackendError('truncated');
  if (parser) yield* emit(parser.items('', true));
  if (['any', 'tool'].includes(choice?.type) && !calls) throw new BackendError('toolRequired');
  if (!visibleText && !calls) throw new BackendError('empty');
  if (textOpen) yield event({ type: 'content_block_stop', index });
  yield event({ type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: usage ?? { output_tokens: Math.ceil(outputChars / 4) } });
  yield event({ type: 'message_stop' });
}

export function errorEvent(error) {
  const failure = error instanceof BackendError ? error : new BackendError('upstream');
  return event({ type: 'error', error: { type: failure.code === 'cooldown' ? 'rate_limit_error' : 'api_error', ...failure.toJSON() } });
}

export async function reconstruct(source) {
  let rest = '', message, complete = false;
  const blocks = [], inputs = new Map();
  const decoder = new TextDecoder();
  function accept(events) {
    for (const parsed of events) {
      let value;
      try { value = JSON.parse(parsed.data); } catch { throw new BackendError('protocol'); }
      if (complete) throw new BackendError('protocol');
      if (value.type === 'error') throw BackendError.fromEnvelope(value.error);
      if (value.type === 'message_start') message = structuredClone(value.message);
      else if (value.type === 'content_block_start') {
        blocks[value.index] = structuredClone(value.content_block);
        if (value.content_block.type === 'tool_use') inputs.set(value.index, '');
      } else if (value.type === 'content_block_delta') {
        if (!blocks[value.index]) throw new BackendError('protocol');
        if (value.delta.type === 'text_delta') blocks[value.index].text += value.delta.text;
        else if (value.delta.type === 'input_json_delta') inputs.set(value.index, (inputs.get(value.index) ?? '') + value.delta.partial_json);
        else throw new BackendError('protocol');
      } else if (value.type === 'content_block_stop') {
        if (inputs.has(value.index)) {
          try { blocks[value.index].input = JSON.parse(inputs.get(value.index)); } catch { throw new BackendError('protocol'); }
          inputs.delete(value.index);
        }
      } else if (value.type === 'message_delta') {
        if (!message) throw new BackendError('protocol');
        Object.assign(message, value.delta);
        Object.assign(message.usage, value.usage);
      } else if (value.type === 'message_stop') complete = true;
      else if (value.type !== 'ping') throw new BackendError('protocol');
    }
  }
  for await (const chunk of source) {
    const parsed = parseSSE(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }), rest);
    rest = parsed.rest;
    accept(parsed.events);
  }
  const parsed = parseSSE(decoder.decode(), rest);
  accept(parsed.events);
  if (parsed.rest || !complete) throw new BackendError('truncated');
  if (!message || inputs.size) throw new BackendError('protocol');
  message.content = blocks;
  return message;
}
