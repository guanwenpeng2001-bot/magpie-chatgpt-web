import { randomUUID, createHash } from 'node:crypto';
import { BackendError } from '../../backend/guard.mjs';
import { errors } from '../errors.mjs';
import { checkToolDefinitions } from '../tool-emulation.mjs';
import { compile } from '../../backend/prompt.mjs';
import { workSelectionPlans } from '../../backend/site-adapter/compatibility.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const MAX_INPUT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function clauseAt(text, at) {
  const before = Math.max(
    text.lastIndexOf('\n', at - 1),
    text.lastIndexOf('.', at - 1),
    text.lastIndexOf('!', at - 1),
    text.lastIndexOf('?', at - 1),
    text.lastIndexOf('。', at - 1),
    text.lastIndexOf('！', at - 1),
    text.lastIndexOf('？', at - 1),
    text.lastIndexOf(';', at - 1),
    text.lastIndexOf('；', at - 1),
  );
  const candidates = ['.', '!', '?', '。', '！', '？', ';', '；', '\n']
    .map(mark => text.indexOf(mark, at))
    .filter(index => index >= 0);
  const after = candidates.length ? Math.min(...candidates) : text.length;
  return text.slice(before + 1, after);
}

function informationalToolQuestion(clause, toolName) {
  const index = clause.toLowerCase().indexOf(toolName.toLowerCase());
  if (index < 0) return false;
  const prefix = clause.slice(0, index).trim();
  return /^(?:what|why|how|when|where|who|which|whether|is|are|does|do|did)\b/i.test(prefix) ||
    /^(?:can|could|would|should|may)\s+(?:i|we|one|someone|a\s+user|an?\s+agent)\b/i.test(prefix) ||
    /(?:能不能|可否|是否|如何|怎么|为什么|会不会|可以吗)[^。！？!?]*$/i.test(prefix);
}

function namedActionMatches(message, tools) {
  if (!message || message.role !== 'user' || message.content == null) return undefined;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = (typeof message.content === 'string'
    ? message.content
    : blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n'))
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, '');
  const matches = tools.flatMap(tool => {
    const name = tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?:$|[^A-Za-z0-9_])`, 'gi');
    return [...text.matchAll(expression)].flatMap(match => {
      const at = match.index + match[0].indexOf(match[0].trim());
      const context = text.slice(Math.max(0, at - 40), Math.min(text.length, at + tool.name.length + 40));
      const execution = /\b(?:use|call|invoke|run|execute)\b|使用|调用|执行/i.test(context);
      const negative = /\b(?:do\s+not|don't|never|without|avoid|explain|meaning)\b|不要|别|禁止|解释|含义/i.test(context);
      const question = informationalToolQuestion(clauseAt(text, at), tool.name);
      return execution && !negative && !question ? [{ tool, at }] : [];
    });
  });
  return matches;
}

function namedActionChoice(message, tools) {
  const matches = namedActionMatches(message, tools);
  if (!matches) return undefined;
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
  const ordered = matches.sort((left, right) => left.at - right.at);
  const unique = [...new Map(ordered.map(match => [match.tool.name, match.tool])).values()];
  if (!unique.length) return undefined;
  if (unique.length === 1) return { type: 'tool', name: unique[0].name };
  const first = ordered[0];
  const second = ordered.find(match => match.tool.name !== first.tool.name);
  const between = text.slice(
    first.at + first.tool.name.length,
    second.at,
  );
  if (/\b(?:or|either|alternatively)\b/i.test(between)) return { type: 'any' };
  return { type: 'tool', name: first.tool.name };
}

function completedToolUses(history) {
  const counts = new Map();
  for (const message of history) {
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
    const marker = '[Previous tool call]\n';
    let offset = 0;
    while ((offset = message.content.indexOf(marker, offset)) >= 0) {
      const start = offset + marker.length;
      const end = message.content.indexOf('\n', start);
      const line = message.content.slice(start, end < 0 ? undefined : end);
      try {
        const call = JSON.parse(line);
        if (typeof call?.name === 'string') counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
      } catch {}
      offset = start;
    }
  }
  return counts;
}

function remainingNamedActionChoice(history, tools) {
  const terminal = history.at(-1);
  if (terminal?.role !== 'user' || typeof terminal.content !== 'string' || !terminal.content.startsWith('[Tool result]')) return undefined;
  const results = [...terminal.content.matchAll(/\[Tool result\]\n([^\n]+)/g)].flatMap(match => {
    try { return [JSON.parse(match[1])]; } catch { return []; }
  });
  if (!results.length || results.some(result => result?.is_error === true)) return undefined;
  let requestIndex = -1;
  for (let index = history.length - 2; index >= 0; index--) {
    const message = history[index];
    if (message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('[Tool result]')) {
      requestIndex = index;
      break;
    }
  }
  if (requestIndex < 0) return undefined;
  const requested = namedActionMatches(
    { role: 'user', content: history[requestIndex].content },
    tools,
  )?.map(match => match.tool.name) ?? [];
  if (!requested.length) return undefined;
  const completed = completedToolUses(history.slice(requestIndex + 1));
  for (const name of requested) {
    const count = completed.get(name) ?? 0;
    if (count > 0) completed.set(name, count - 1);
    else return { type: 'tool', name };
  }
  return undefined;
}

function selectionModel(model, effort) {
  const value = typeof model === 'string' ? model : '';
  const requested = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  if (!requested) return value;
  if (value === 'gpt-5-6' || value === 'gpt-6') {
    const suffix = {
      low: '-instant',
      medium: '',
      high: '-high',
      xhigh: '-extra-high',
      max: '-pro',
    }[requested];
    if (suffix === undefined) throw new BackendError('invalidRequest');
    return value + suffix;
  }
  if (Object.hasOwn(workSelectionPlans, value) && workSelectionPlans[value].effort === 'Medium') {
    if (requested === 'medium') return value;
    const variant = `${value}-${requested.replaceAll('_', '-')}`;
    if (!Object.hasOwn(workSelectionPlans, variant)) throw new BackendError('invalidRequest');
    return variant;
  }
  return value;
}

function attachmentError(kind) {
  const error = new BackendError('unsupported');
  error.code = 'attachmentUnsupported';
  error.message = errors.attachmentUnsupported.template.replace('{kind}', kind).replace('{maxCount}', MAX_INPUT_IMAGES).replace('{maxBytes}', '10 MiB');
  error.toJSON = () => ({ status: 400, code: error.code, values: { kind, maxCount: MAX_INPUT_IMAGES, maxBytes: '10 MiB' }, message: error.message });
  return error;
}

export function prepare(request, headers = new Headers()) {
  if (!request || typeof request.model !== 'string' || !request.model || !Array.isArray(request.messages) || !request.messages.length) throw new BackendError('invalidRequest');
  if (request.max_tokens !== undefined && (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0)) throw new BackendError('invalidRequest');
  if (request.stop_sequences !== undefined && (!Array.isArray(request.stop_sequences) || request.stop_sequences.some(stop => typeof stop !== 'string' || !stop.length))) throw new BackendError('invalidRequest');
  const tools = request.tools ?? [];
  checkToolDefinitions(tools);
  let toolChoice = request.tool_choice ?? { type: 'auto' };
  let toolExposureReason = request.tool_choice === undefined ? 'host-auto' : 'host-choice';
  if (!object(toolChoice) || !['auto', 'any', 'tool', 'none'].includes(toolChoice.type) || (toolChoice.disable_parallel_tool_use !== undefined && typeof toolChoice.disable_parallel_tool_use !== 'boolean')) throw new BackendError('toolChoice');
  if (toolChoice.type === 'tool' && !tools.some(tool => tool.name === toolChoice.name) || ['tool', 'any'].includes(toolChoice.type) && !tools.length) throw new BackendError('toolChoice');
  if (request.tool_choice === undefined && tools.length) {
    const message = request.messages.at(-1);
    const named = namedActionChoice(message, tools);
    if (named) {
      toolChoice = named;
      toolExposureReason = 'explicit-named-action';
    }
  }
  const images = [];
  const imageHistoryIndices = [];
  let historyIndex = 0;
  function textContent(content, allowTools = true, allowImages = true) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) throw new BackendError('unsupported');
    return content.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (allowImages && block?.type === 'image') {
        const source = block.source;
        if (source?.type !== 'base64' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.media_type) || typeof source.data !== 'string' || !source.data.length) throw attachmentError('unsupported image');
        if (source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw attachmentError('an oversized image');
        const bytes = Buffer.from(source.data, 'base64');
        if (bytes.toString('base64') !== source.data || bytes.length > MAX_IMAGE_BYTES || images.length >= MAX_INPUT_IMAGES) throw attachmentError('invalid or over-cap images');
        imageHistoryIndices.push(historyIndex);
        images.push({
          mediaType: source.media_type,
          dataBase64: source.data,
          bytes: bytes.length,
          ...(source.detail === 'original' ? { detail: 'original' } : {}),
        });
        return '[Image]';
      }
      if (allowTools && block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
        return `[Previous tool call]\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}`;
      }
      if (allowTools && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        return `[Tool result]\n${JSON.stringify({ tool_use_id: block.tool_use_id, is_error: !!block.is_error, content: textContent(block.content ?? [], false) })}`;
      }
      throw attachmentError('an unsupported content block');
    }).join('\n');
  }
  const systems = request.system === undefined ? [] : [textContent(request.system, false, false)];
  const history = request.messages.flatMap(message => {
    if (!message || !['user', 'assistant', 'system'].includes(message.role)) throw new BackendError('invalidRequest');
    if (message.role === 'system') {
      systems.push(textContent(message.content, false, false));
      return [];
    }
    const entry = { role: message.role, content: textContent(message.content) };
    historyIndex++;
    return entry;
  });
  if (!history.length) throw new BackendError('invalidRequest');
  if (request.tool_choice === undefined && tools.length && toolChoice.type === 'auto') {
    const remaining = remainingNamedActionChoice(history, tools);
    if (remaining) {
      toolChoice = remaining;
      toolExposureReason = 'remaining-named-action';
    }
  }
  const clientAction = ['any', 'tool'].includes(toolChoice.type);
  const textOnly = toolChoice.type === 'none';
  const system = systems.join('\n\n');
  const nonce = randomUUID().replaceAll('-', '');
  const requestHeaders = new Headers(headers);
  const session = requestHeaders.get('x-chatgptweb-conversation');
  const effort = requestHeaders.get('x-magpie-effort');
  const supplied = request.conversation_id;
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 512)) throw new BackendError('invalidRequest');
  const prepared = { model: request.model, selectionModel: selectionModel(request.model, effort), history, system, tools, toolChoice, choice: toolChoice,
    bindingChoice: request.tool_choice ?? { type: 'auto' },
    toolExposure: tools.length ? (clientAction ? 'selected' : textOnly ? 'none' : 'available') : 'absent',
    toolExposureReason: tools.length ? toolExposureReason : 'no-tools',
    ...(tools.length && textOnly ? { promptTools: [] } : {}),
    start: `[MAGPIE_TOOL_${nonce}]`, end: `[/MAGPIE_TOOL_${nonce}]`,
    ...(images.length ? { images, imageHistoryIndices } : {}), stream: request.stream !== false,
    ...(request.max_tokens !== undefined ? { maxTokens: request.max_tokens } : {}),
    stopSequences: request.stop_sequences ?? [],
    conversationKey: supplied ?? (session ? createHash('sha256').update(session).digest('hex') : undefined) };
  prepared.prompt = compile(prepared);
  return prepared;
}
