import { randomUUID, createHash } from 'node:crypto';
import { BackendError } from '../../backend/guard.mjs';
import { errors } from '../errors.mjs';
import { checkToolDefinitions } from '../tool-emulation.mjs';
import { compile } from '../../backend/prompt.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const MAX_INPUT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function namedActionChoice(message, tools) {
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
      return execution && !negative ? [tool] : [];
    });
  });
  const unique = [...new Map(matches.map(tool => [tool.name, tool])).values()]
    .sort((left, right) => right.name.length - left.name.length);
  if (unique.length === 1 && unique[0].name !== 'apply_patch') return { type: 'tool', name: unique[0].name };
  return unique.length > 1 ? { type: 'any' } : undefined;
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
  const tools = request.tools ?? [];
  checkToolDefinitions(tools);
  let toolChoice = request.tool_choice ?? { type: 'auto' };
  if (!object(toolChoice) || !['auto', 'any', 'tool', 'none'].includes(toolChoice.type) || (toolChoice.disable_parallel_tool_use !== undefined && typeof toolChoice.disable_parallel_tool_use !== 'boolean')) throw new BackendError('toolChoice');
  if (toolChoice.type === 'tool' && !tools.some(tool => tool.name === toolChoice.name) || ['tool', 'any'].includes(toolChoice.type) && !tools.length) throw new BackendError('toolChoice');
  if (request.tool_choice === undefined && tools.length) {
    toolChoice = namedActionChoice(request.messages.at(-1), tools) ?? toolChoice;
  }
  const images = [];
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
    return { role: message.role, content: textContent(message.content) };
  });
  if (!history.length) throw new BackendError('invalidRequest');
  const system = systems.join('\n\n');
  const nonce = randomUUID().replaceAll('-', '');
  const session = new Headers(headers).get('x-chatgptweb-conversation');
  const supplied = request.conversation_id;
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 512)) throw new BackendError('invalidRequest');
  const prepared = { model: request.model, history, system, tools, toolChoice, choice: toolChoice,
    start: `[MAGPIE_TOOL_${nonce}]`, end: `[/MAGPIE_TOOL_${nonce}]`,
    ...(images.length ? { images } : {}), stream: request.stream !== false,
    conversationKey: supplied ?? (session ? createHash('sha256').update(session).digest('hex') : undefined) };
  prepared.prompt = compile(prepared);
  return prepared;
}
