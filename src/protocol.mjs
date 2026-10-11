import { randomUUID, createHash } from 'node:crypto';
import { BackendError } from '../backend/guard.mjs';
import { checkSchema, validateInput } from './schema.mjs';

// Prompt-level emulation adapted from magpie-claudeweb2api; see THIRD_PARTY_NOTICES.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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

function textContent(content, allowTools = true) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new BackendError('unsupported');
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (allowTools && block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
      return `[Previous tool call]\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}`;
    }
    if (allowTools && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      return `[Tool result]\n${JSON.stringify({ tool_use_id: block.tool_use_id, is_error: !!block.is_error, content: textContent(block.content ?? [], false) })}`;
    }
    throw new BackendError('unsupported');
  }).join('\n');
}

export function prepare(request, headers = new Headers()) {
  if (!request || typeof request.model !== 'string' || !request.model || !Array.isArray(request.messages) || !request.messages.length) throw new BackendError('invalidRequest');
  const tools = request.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128 || tools.some(tool => !object(tool) || typeof tool.name !== 'string' || !tool.name || !object(tool.input_schema))) throw new BackendError('toolDefinition');
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new BackendError('toolDefinition');
  for (const tool of tools) checkSchema(tool.input_schema);
  const choice = request.tool_choice ?? { type: 'auto' };
  if (!object(choice) || !['auto', 'any', 'tool', 'none'].includes(choice.type) || (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean')) throw new BackendError('toolChoice');
  if (choice.type === 'tool' && !tools.some(tool => tool.name === choice.name) || ['tool', 'any'].includes(choice.type) && !tools.length) throw new BackendError('toolChoice');
  const nonce = randomUUID().replaceAll('-', '');
  const start = `[MAGPIE_TOOL_${nonce}]`, end = `[/MAGPIE_TOOL_${nonce}]`;
  const history = request.messages.map(message => {
    if (!['user', 'assistant'].includes(message.role)) throw new BackendError('invalidRequest');
    return { role: message.role, content: textContent(message.content) };
  });
  const system = request.system === undefined ? '' : textContent(request.system, false);
  const parts = [system && `[System]\n${system}`, ...history.map(message => `[${message.role === 'user' ? 'Human' : 'Assistant'}]\n${message.content}`)].filter(Boolean);
  if (tools.length) {
    parts.push(`[Tool protocol]\nTools are executed by the client. To request a tool, emit ${start}{"name":"tool_name","input":{...}}${end}. Use only these delimiters for new calls; previous calls in the transcript are historical. Do not invent tool results. Stop after emitting the requested calls. You may include normal text outside calls. Match each input_schema. Tool choice auto permits text or calls; any requires a call; tool requires the named tool; none forbids calls. When disable_parallel_tool_use is true, emit at most one call.\nTool definitions: ${JSON.stringify(tools)}\nTool choice: ${JSON.stringify(choice)}`);
    parts.push('[Assistant]\n');
  }
  const prompt = parts.join('\n\n');
  const session = new Headers(headers).get('x-chatgptweb-conversation');
  const supplied = request.conversation_id;
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 512)) throw new BackendError('invalidRequest');
  // Tool history is replayed in full in a fresh temporary chat: generated call IDs
  // differ from the raw web transcript, so text-only continuation cannot bind it.
  const toolHistory = request.messages.some(message => Array.isArray(message.content) && message.content.some(block => ['tool_use', 'tool_result'].includes(block?.type)));
  return { model: request.model, prompt, history, system, tools, choice, start, end, conversationKey: tools.length || toolHistory ? undefined : supplied ?? (session ? createHash('sha256').update(session).digest('hex') : undefined) };
}

// Incremental framing retains only a possible opening delimiter outside calls.
export class ToolParser {
  buffer = '';
  inside = false;
  scanned = 0;
  nesting = 0;
  quoted = false;
  escaped = false;
  jsonEnd = -1;
  constructor(prepared) { this.p = prepared; }
  feed(text, final = false) { return Array.from(this.items(text, final)); }
  *items(text, final = false) {
    this.buffer += text;
    while (this.buffer.length) {
      if (!this.inside) {
        const index = this.buffer.indexOf(this.p.start);
        if (index >= 0) {
          if (index) yield { text: this.buffer.slice(0, index) };
          this.buffer = this.buffer.slice(index + this.p.start.length);
          this.inside = true;
          continue;
        }
        let keep = 0;
        if (!final) for (let length = Math.min(this.buffer.length, this.p.start.length - 1); length > 0; length--) {
          if (this.buffer.endsWith(this.p.start.slice(0, length))) { keep = length; break; }
        }
        const ready = this.buffer.slice(0, this.buffer.length - keep);
        if (ready) yield { text: ready };
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }
      if (this.jsonEnd < 0 && this.buffer.trimStart() && !this.buffer.trimStart().startsWith('{')) throw new BackendError('toolJSON');
      for (let index = this.scanned; this.jsonEnd < 0 && index < this.buffer.length; index++) {
        const char = this.buffer[index];
        this.scanned = index + 1;
        if (this.quoted) {
          if (this.escaped) this.escaped = false;
          else if (char === '\\') this.escaped = true;
          else if (char === '"') this.quoted = false;
          continue;
        }
        if (char === '"') this.quoted = true;
        else if (char === '{' || char === '[') this.nesting++;
        else if (char === '}' || char === ']') { if (--this.nesting === 0) this.jsonEnd = index + 1; }
      }
      const json = this.jsonEnd < 0 ? this.buffer : this.buffer.slice(0, this.jsonEnd);
      if (Buffer.byteLength(json) > 1024 * 1024) throw new BackendError('toolLimit');
      if (this.jsonEnd < 0) break;
      const suffix = this.buffer.slice(this.jsonEnd);
      const rest = suffix.trimStart();
      if (suffix.length - rest.length > 8192) throw new BackendError('toolLimit');
      if (!rest.startsWith(this.p.end)) {
        if (!final && this.p.end.startsWith(rest)) break;
        throw new BackendError(final && this.p.end.startsWith(rest) ? 'toolIncomplete' : 'toolDelimiter');
      }
      let call;
      try { call = JSON.parse(this.buffer.slice(0, this.jsonEnd)); } catch { throw new BackendError('toolJSON'); }
      const tool = this.p.tools.find(tool => tool.name === call.name);
      if (!tool) throw new BackendError('toolUnknown');
      if (!object(call.input)) throw new BackendError('toolSchema');
      if (this.p.choice.type === 'none' || this.p.choice.type === 'tool' && tool.name !== this.p.choice.name) throw new BackendError('toolChoiceViolation');
      validateInput(call.input, tool.input_schema);
      yield { tool: { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), name: call.name, input: call.input } };
      this.buffer = rest.slice(this.p.end.length);
      this.inside = false;
      this.scanned = this.nesting = 0;
      this.quoted = this.escaped = false;
      this.jsonEnd = -1;
    }
    if (final && this.inside) throw new BackendError('toolIncomplete');
  }
}

const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
export async function* translate(source, prepared) {
  const { model, prompt } = prepared;
  const answer = new AnswerStream();
  const parser = prepared.tools?.length ? new ToolParser(prepared) : null;
  let index = 0, textOpen = false, calls = 0, outputChars = 0;
  yield event({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 0 } } });
  function* emit(items) {
    for (const item of items) {
      if (item.text) {
        if (!textOpen) { yield event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); textOpen = true; }
        outputChars += [...item.text].length;
        yield event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: item.text } });
      } else if (item.tool) {
        if (++calls > 1 && prepared.choice.disable_parallel_tool_use) throw new BackendError('toolParallel');
        if (textOpen) { yield event({ type: 'content_block_stop', index: index++ }); textOpen = false; }
        const { input, ...block } = item.tool;
        const json = JSON.stringify(input);
        outputChars += [...json].length;
        // Render validated arguments whole; the web channel supplied ordinary text.
        yield event({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        yield event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } });
        yield event({ type: 'content_block_stop', index: index++ });
      }
    }
  }
  for await (const frame of source) {
    const text = answer.accept(frame);
    if (text) yield* emit(parser ? parser.items(text) : [{ text }]);
  }
  if (parser) yield* emit(parser.items('', true));
  if (['any', 'tool'].includes(prepared.choice?.type) && !calls) throw new BackendError('toolRequired');
  answer.finish();
  if (textOpen) yield event({ type: 'content_block_stop', index });
  yield event({ type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(outputChars / 4) } });
  yield event({ type: 'message_stop' });
}

export function errorEvent(error) {
  const failure = error instanceof BackendError ? error : new BackendError('upstream');
  return event({ type: 'error', error: { type: failure.code === 'cooldown' ? 'rate_limit_error' : 'api_error', ...failure.toJSON() } });
}
