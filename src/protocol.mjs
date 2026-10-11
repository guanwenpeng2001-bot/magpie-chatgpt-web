import { randomUUID, createHash } from 'node:crypto';
import { BackendError } from '../backend/guard.mjs';

const answerPath = '/message/content/parts/0';
const auxiliaryTypes = new Set(['resume_conversation_token', 'message_marker', 'server_ste_metadata', 'conversation_detail_metadata']);

export class AnswerStream {
  text = '';
  complete = false;
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
      this.assistant = message.author?.role === 'assistant';
      this.visible = this.assistant && message.recipient === 'all' && (!message.channel || message.channel === 'final');
      if (this.assistant && message.metadata?.is_visually_hidden_from_conversation === true) throw new BackendError('hidden');
      if (this.visible) {
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

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new BackendError('unsupported');
  return content.map(block => block.text).join('\n');
}

export function prepare(request, headers = new Headers()) {
  if (!request || typeof request.model !== 'string' || !request.model || !Array.isArray(request.messages) || !request.messages.length) throw new BackendError('invalidRequest');
  if (request.tools?.length || request.tool_choice) throw new BackendError('unsupported');
  const history = request.messages.map(message => {
    if (!['user', 'assistant'].includes(message.role)) throw new BackendError('invalidRequest');
    return { role: message.role, content: textContent(message.content) };
  });
  const system = request.system === undefined ? '' : textContent(request.system);
  const prompt = [system && `[System]\n${system}`, ...history.map(message => `[${message.role === 'user' ? 'Human' : 'Assistant'}]\n${message.content}`)].filter(Boolean).join('\n\n');
  const session = new Headers(headers).get('x-chatgptweb-conversation');
  const supplied = request.conversation_id;
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 512)) throw new BackendError('invalidRequest');
  return { model: request.model, prompt, history, system, conversationKey: supplied ?? (session ? createHash('sha256').update(session).digest('hex') : undefined) };
}

const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
export async function* translate(source, { model, prompt }) {
  const answer = new AnswerStream();
  yield event({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 0 } } });
  yield event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for await (const frame of source) {
    const text = answer.accept(frame);
    if (text) yield event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  }
  answer.finish();
  yield event({ type: 'content_block_stop', index: 0 });
  yield event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(answer.text.length / 4) } });
  yield event({ type: 'message_stop' });
}

export function errorEvent(error) {
  const failure = error instanceof BackendError ? error : new BackendError('upstream');
  return event({ type: 'error', error: { type: failure.code === 'cooldown' ? 'rate_limit_error' : 'api_error', ...failure.toJSON() } });
}
