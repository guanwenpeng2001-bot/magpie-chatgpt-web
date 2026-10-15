import { randomUUID, createHash } from 'node:crypto';
import { BackendError } from '../../backend/guard.mjs';
import { errors } from '../errors.mjs';
import { checkToolDefinitions } from '../tool-emulation.mjs';
import { compile } from '../../backend/prompt.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const MAX_INPUT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function attachmentError(kind) {
  const error = new BackendError('unsupported');
  error.code = 'attachmentUnsupported';
  error.message = errors.attachmentUnsupported.template.replace('{kind}', kind).replace('{maxCount}', MAX_INPUT_IMAGES).replace('{maxBytes}', MAX_IMAGE_BYTES);
  error.toJSON = () => ({ status: 400, code: error.code, values: { kind, maxCount: MAX_INPUT_IMAGES, maxBytes: MAX_IMAGE_BYTES }, message: error.message });
  return error;
}

export function prepare(request, headers = new Headers()) {
  if (!request || typeof request.model !== 'string' || !request.model || !Array.isArray(request.messages) || !request.messages.length) throw new BackendError('invalidRequest');
  const tools = request.tools ?? [];
  checkToolDefinitions(tools);
  const toolChoice = request.tool_choice ?? { type: 'auto' };
  if (!object(toolChoice) || !['auto', 'any', 'tool', 'none'].includes(toolChoice.type) || (toolChoice.disable_parallel_tool_use !== undefined && typeof toolChoice.disable_parallel_tool_use !== 'boolean')) throw new BackendError('toolChoice');
  if (toolChoice.type === 'tool' && !tools.some(tool => tool.name === toolChoice.name) || ['tool', 'any'].includes(toolChoice.type) && !tools.length) throw new BackendError('toolChoice');
  const images = [];
  let toolHistory = false;
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
        images.push({ mediaType: source.media_type, dataBase64: source.data, bytes: bytes.length });
        return '[Image]';
      }
      if (allowTools && block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
        toolHistory = true;
        return `[Previous tool call]\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}`;
      }
      if (allowTools && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolHistory = true;
        return `[Tool result]\n${JSON.stringify({ tool_use_id: block.tool_use_id, is_error: !!block.is_error, content: textContent(block.content ?? [], false) })}`;
      }
      throw attachmentError('an unsupported content block');
    }).join('\n');
  }
  const history = request.messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role)) throw new BackendError('invalidRequest');
    return { role: message.role, content: textContent(message.content) };
  });
  const system = request.system === undefined ? '' : textContent(request.system, false, false);
  const nonce = randomUUID().replaceAll('-', '');
  const session = new Headers(headers).get('x-chatgptweb-conversation');
  const supplied = request.conversation_id;
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 512)) throw new BackendError('invalidRequest');
  const prepared = { model: request.model, history, system, tools, toolChoice, choice: toolChoice,
    start: `[MAGPIE_TOOL_${nonce}]`, end: `[/MAGPIE_TOOL_${nonce}]`,
    ...(images.length ? { images } : {}), stream: request.stream !== false,
    conversationKey: tools.length || toolHistory ? undefined : supplied ?? (session ? createHash('sha256').update(session).digest('hex') : undefined) };
  prepared.prompt = compile(prepared);
  return prepared;
}
