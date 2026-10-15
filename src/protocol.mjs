import { BackendError } from '../backend/guard.mjs';
import { translate as translateWire } from './wire/translate.mjs';
export { prepare } from './wire/prepare.mjs';
export { errorEvent } from './wire/translate.mjs';
export { ToolParser, checkToolDefinitions } from './tool-emulation.mjs';

const answerPath = '/message/content/parts/0';
const auxiliaryTypes = new Set(['resume_conversation_token', 'message_marker', 'server_ste_metadata', 'conversation_detail_metadata']);

export class AnswerStream {
  text = '';
  complete = false;
  handedOff = false;
  assistant = false;
  visible = false;
  operation = 'add';
  path = '';
  accept(frame) {
    const before = this.text;
    if (frame.event === 'answer') {
      if (typeof frame.data?.text !== 'string') throw new BackendError('protocol');
      this.text += frame.data.text;
    } else if (frame.event === 'dom') {
      if (typeof frame.data?.text !== 'string' || !frame.data.text.startsWith(this.text)) throw new BackendError('protocol');
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
      if (assistant && message.metadata?.is_visually_hidden_from_conversation === true) throw new BackendError('hidden');
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
    if (this.assistant && patch.p === '/message/metadata/is_visually_hidden_from_conversation' && patch.v === true) throw new BackendError('hidden');
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
    if (!text.startsWith(this.text)) throw new BackendError('protocol');
    this.text = text;
  }
  finish() {
    if (!this.complete) throw new BackendError('truncated');
    if (!this.text.trim()) throw new BackendError('empty');
  }
}

// Legacy upstream frames remain supported until the turn driver migrates.
export async function* translate(source, prepared) {
  const answer = new AnswerStream();
  async function* normalized() {
    for await (const frame of source) {
      const text = answer.accept(frame);
      if (text) yield { type: 'delta', index: 0, text };
    }
    answer.finish();
    yield { type: 'finish', reason: 'complete' };
  }
  yield* translateWire(normalized(), prepared);
}
