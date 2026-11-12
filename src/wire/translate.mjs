import { randomUUID } from 'node:crypto';
import { BackendError } from '../../backend/guard.mjs';
import { ToolParser } from '../tool-emulation.mjs';
import { errors } from '../errors.mjs';
import { estimateTextTokens } from '../usage/context.mjs';
import { parseSSE, encodeSSE } from './sse.mjs';

const answerPath = '/message/content/parts/0';
const auxiliaryTypes = new Set(['resume_conversation_token', 'message_marker', 'server_ste_metadata', 'conversation_detail_metadata']);

export class AnswerStream {
  text = '';
  complete = false;
  handedOff = false;
  assistant = false;
  visible = false;
  hidden = false;
  operation = 'add';
  path = '';
  accept(frame) {
    const before = this.text;
    if (frame.event === 'answer') {
      if (typeof frame.data?.text !== 'string') throw new BackendError('protocol');
      this.text += frame.data.text;
    } else if (frame.event === 'dom') {
      if (typeof frame.data?.text !== 'string') throw new BackendError('protocol');
      this.text = frame.data.text;
      this.complete ||= frame.data.complete === true;
    } else if (frame.event === 'delta_encoding') {
      if (frame.data !== 'v1') throw new BackendError('protocol');
    } else if (frame.event === 'delta') {
      const patch = frame.data;
      if (!patch || typeof patch !== 'object') throw new BackendError('protocol');
      this.operation = patch.o ?? this.operation;
      this.path = patch.p ?? this.path;
      this.apply({ ...patch, o: this.operation, p: this.path });
    } else if (!frame.event || frame.event === 'message') {
      if (frame.data === '[DONE]' || frame.data?.type === 'message_stream_complete') this.complete = true;
      else if (frame.data?.type === 'stream_handoff') this.handedOff = true;
      else if (!auxiliaryTypes.has(frame.data?.type)) throw new BackendError('protocol');
    } else throw new BackendError('protocol');
    return this.text.slice(before.length);
  }
  apply(patch) {
    if (!patch || !['add', 'replace', 'append', 'patch', 'remove'].includes(patch.o)) throw new BackendError('protocol');
    if (patch.o === 'patch') {
      if (!Array.isArray(patch.v)) throw new BackendError('protocol');
      for (const operation of patch.v) this.apply(operation);
      return;
    }
    if (patch.p === '' && patch.v?.message) {
      const message = patch.v.message;
      const assistant = message.author?.role === 'assistant';
      if (assistant && message.metadata?.is_visually_hidden_from_conversation === true) {
        this.hidden = true;
        return;
      }
      if (assistant && message.recipient === 'all' && (!message.channel || message.channel === 'final')) {
        if (this.visible && this.text) throw new BackendError('protocol');
        this.visible = true;
        this.assistant = true;
        if (message.content?.content_type !== 'text' || !Array.isArray(message.content.parts) || message.content.parts.some(part => typeof part !== 'string')) throw new BackendError('protocol');
        this.extend(message.content.parts[0] ?? '');
        this.complete ||= message.status === 'finished_successfully';
      }
      return;
    }
    if (typeof patch.p !== 'string' || !patch.p.startsWith('/message/')) throw new BackendError('protocol');
    if (this.assistant && patch.p === '/message/metadata/is_visually_hidden_from_conversation' && patch.v === true) {
      this.hidden = true;
      return;
    }
    if (!this.visible) return;
    if (patch.p === answerPath) {
      if (typeof patch.v !== 'string') throw new BackendError('protocol');
      if (patch.o === 'append') this.text += patch.v;
      else if (patch.o === 'replace' || patch.o === 'add') this.extend(patch.v);
      else throw new BackendError('protocol');
    } else if (patch.p === '/message/status') {
      if (!['in_progress', 'finished_successfully'].includes(patch.v)) throw new BackendError('upstream');
      this.complete ||= patch.v === 'finished_successfully';
    } else if (!/^\/message\/(metadata(?:\/|$)|end_turn$|recipient$|channel$)/.test(patch.p)) throw new BackendError('protocol');
  }
  extend(text) {
    this.text = text;
  }
  finish() {
    if (!this.complete) throw new BackendError('truncated');
    if (!this.text.trim()) throw new BackendError(this.hidden ? 'hidden' : 'empty');
  }
}

const event = value => encodeSSE({ event: value.type, data: value });

export function backendFrameError(frame) {
  if (!Object.hasOwn(errors, frame.code) || typeof frame.message !== 'string') throw new BackendError('protocol');
  if (frame.retryAfter !== undefined && (!Number.isSafeInteger(frame.retryAfter) || frame.retryAfter < 0)) throw new BackendError('protocol');
  const failure = new BackendError(frame.code, { retryAfter: frame.retryAfter });
  if (frame.retryAfter !== undefined) failure.retryAfter = String(frame.retryAfter);
  failure.message = frame.message;
  const envelope = { status: failure.status, code: failure.code, message: failure.message };
  if (failure.signIn) envelope.signIn = failure.signIn;
  if (failure.retryAfter) envelope.retryAfter = failure.retryAfter;
  failure.toJSON = () => ({ ...envelope });
  return failure;
}

export async function* translate(source, prepared) {
  const parser = prepared.tools?.length ? new ToolParser(prepared) : null;
  const choice = prepared.toolChoice ?? prepared.choice;
  let index = 0, textOpen = false, calls = 0, outputText = '', complete = false, usage, visibleText = false;
  const stops = prepared.stopSequences ?? [];
  const maxTokens = prepared.maxTokens ?? Infinity;
  let pendingText = '', stopReason, stopSequence = null;
  const inputTokens = prepared.usageEstimate?.inputTokens
    ?? estimateTextTokens(prepared.prompt ?? JSON.stringify(prepared.history ?? []));
  yield event({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: prepared.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
  function limited(text) {
    if (estimateTextTokens(outputText + text) <= maxTokens) return text;
    const chars = Array.from(text);
    let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTextTokens(outputText + chars.slice(0, mid).join('')) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    stopReason = 'max_tokens';
    stopSequence = null;
    return chars.slice(0, low).join('');
  }
  function* flushText(final = false) {
    let end = pendingText.length, matched;
    for (const stop of stops) {
      const at = pendingText.indexOf(stop);
      if (at >= 0 && (matched === undefined || at < end)) { end = at; matched = stop; }
    }
    if (matched !== undefined) { stopReason = 'stop_sequence'; stopSequence = matched; }
    else if (!final) {
      // Keep only a suffix that could become a stop across chunk boundaries.
      for (const stop of stops) for (let n = Math.min(stop.length - 1, pendingText.length); n > 0; n--) {
        if (pendingText.endsWith(stop.slice(0, n))) { end = Math.min(end, pendingText.length - n); break; }
      }
      // Do not split UTF-16 pairs when upstream splits a code point.
      if (end && /[\uD800-\uDBFF]/.test(pendingText[end - 1])) end--;
    }
    const text = limited(pendingText.slice(0, end));
    pendingText = stopReason ? '' : pendingText.slice(end);
    if (!text) return;
    if (!textOpen) { yield event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); textOpen = true; }
    visibleText ||= !!text.trim();
    outputText += text;
    yield event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  }
  function* emit(items) {
    for (const item of items) {
      if (stopReason) return;
      if (item.text) {
        pendingText += item.text;
        yield* flushText();
        if (stopReason) return;
      } else if (item.tool) {
        yield* flushText(true);
        if (stopReason) return;
        const json = JSON.stringify(item.tool.input);
        // Tool blocks are atomic: never send invalid partial JSON as a call.
        const match = stops.map(stop => ({ stop, at: json.indexOf(stop) })).filter(item => item.at >= 0).sort((a, b) => a.at - b.at)[0];
        if (match) {
          if (limited(json.slice(0, match.at)) === json.slice(0, match.at)) {
            stopReason = 'stop_sequence';
            stopSequence = match.stop;
          }
          return;
        }
        if (limited(json) !== json) return;
        if (++calls > 1 && choice.disable_parallel_tool_use) throw new BackendError('toolParallel');
        if (textOpen) { yield event({ type: 'content_block_stop', index: index++ }); textOpen = false; }
        const { input, ...block } = item.tool;
        outputText += json;
        yield event({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        yield event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } });
        yield event({ type: 'content_block_stop', index: index++ });
      }
    }
  }
  for await (const frame of source) {
    if (!frame || complete || !['delta', 'finish', 'error'].includes(frame.type)) throw new BackendError('protocol');
    if (frame.type === 'error') throw backendFrameError(frame);
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
    if (stopReason) break;
  }
  if (!complete && !stopReason) throw new BackendError('truncated');
  if (parser && !stopReason) yield* emit(parser.items('', true));
  if (!stopReason) yield* flushText(true);
  if (!stopReason && ['any', 'tool'].includes(choice?.type) && !calls) throw new BackendError('toolRequired');
  if (!stopReason && !visibleText && !calls) throw new BackendError('empty');
  if (textOpen) yield event({ type: 'content_block_stop', index });
  yield event({ type: 'message_delta', delta: { stop_reason: stopReason ?? (calls ? 'tool_use' : 'end_turn'), stop_sequence: stopSequence }, usage: (!stopReason && usage) || { output_tokens: estimateTextTokens(outputText) } });
  yield event({ type: 'message_stop' });
}

export function errorType(failure) {
  return failure.code === 'cooldown'
    ? 'rate_limit_error'
    : failure.code === 'expired' ? 'authentication_error'
      : failure.status < 500 ? 'invalid_request_error' : 'api_error';
}

export function errorEvent(error) {
  const failure = error instanceof BackendError ? error : new BackendError('upstream');
  return event({ type: 'error', error: { type: errorType(failure), ...failure.toJSON() } });
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
        if (!message?.usage || !value.usage) throw new BackendError('protocol');
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
