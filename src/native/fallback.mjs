import { randomUUID } from 'node:crypto';
import { nativeRoute } from './models.mjs';

export function isCompaction(body, path, headers) {
  if (path.endsWith('/responses/compact')) return true;
  if (Array.isArray(body?.input) && body.input.some(item => item?.type === 'compaction_trigger')) return true;
  let turn = new Headers(headers).get('x-codex-turn-metadata') ?? body?.client_metadata?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { return false; } }
  return turn?.request_kind === 'compaction';
}

function content(block) {
  if (['input_text', 'output_text', 'text'].includes(block.type)) return { type: 'text', text: block.text };
  if (block.type === 'input_image') {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(block.image_url ?? '');
    if (!match) throw new Error('Text fallback requires an inline image');
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  }
  throw new Error('Unsupported Responses content in text fallback');
}

function toolDefinitions(tools = [], namespace) {
  return tools.flatMap(tool => {
    if (tool.type === 'namespace') return toolDefinitions(tool.tools, tool.name);
    if (tool.type === 'tool_search') return []; // All function schemas are already exposed in text mode.
    if (!['function', 'custom'].includes(tool.type)) throw new Error('Unsupported native tool in text fallback');
    return [{ ...tool, namespace: tool.namespace ?? namespace,
      textName: (tool.namespace ?? namespace) ? `${tool.namespace ?? namespace}.${tool.name}` : tool.name }];
  });
}

export function toTextRequest(body, compact = false) {
  const messages = [];
  let system = body.instructions ?? '';
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) throw new Error('Responses input must be an array or string');
  for (const item of input) {
    if (item.type === 'reasoning') {
      const text = (item.summary ?? []).map(part => part.text ?? '').join('\n');
      if (text) messages.push({ role: 'assistant', content: text });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id, name: item.namespace ? `${item.namespace}.${item.name}` : item.name,
        input: item.type === 'custom_tool_call' ? { input: item.input } : JSON.parse(item.arguments || '{}') }] });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) }] });
    } else if (item.role) {
      const blocks = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : (item.content ?? []).map(content);
      if (['system', 'developer'].includes(item.role)) system += '\n' + blocks.map(block => block.text ?? '').join('\n');
      else messages.push({ role: item.role, content: blocks });
    } else throw new Error('Unsupported Responses item in text fallback');
  }
  if (compact) {
    system += '\nSummarize the conversation for continuation. Preserve decisions, constraints, tool results, and unfinished work. Return only a plain-text summary. Do not call tools.';
    messages.push({ role: 'user', content: 'Produce the continuation summary now.' });
  }
  const tools = compact ? [] : toolDefinitions(body.tools).flatMap(tool => {
    if (tool.type === 'function') return [{ name: tool.textName, description: tool.description, input_schema: tool.parameters ?? { type: 'object', properties: {} } }];
    if (tool.type === 'custom') return [{ name: tool.textName, description: tool.description,
      input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }];
    throw new Error('Unsupported native tool in text fallback');
  });
  const route = nativeRoute(body.model);
  const slug = route?.slug ?? body.model;
  const model = !route ? body.model : slug.startsWith('gpt-6') ? 'gpt-6' : slug.startsWith('gpt-5.6-sol') || slug === 'gpt-5.6-pro' ? 'gpt-5-6' : 'auto';
  const choice = body.tool_choice;
  return { model, system, messages, tools, stream: false, max_tokens: body.max_output_tokens ?? 34834,
    ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(!compact && choice ? { tool_choice: typeof choice === 'string' ? { type: choice === 'required' ? 'any' : choice }
      : { type: 'tool', name: choice.namespace ? `${choice.namespace}.${choice.name}` : choice.name } } : {}) };
}

export async function textFallback(body, compact, fetchText, signal) {
  const request = toTextRequest(body, compact);
  const response = await fetchText(request);
  if (!response.ok) return response;
  const message = await response.json();
  const id = `resp_${randomUUID().replaceAll('-', '')}`;
  const output = (message.content ?? []).map(block => {
    if (block.type === 'tool_use') {
      const definition = toolDefinitions(body.tools).find(tool => tool.textName === block.name);
      const custom = definition?.type === 'custom';
      return { id: `fc_${randomUUID()}`, type: custom ? 'custom_tool_call' : 'function_call', call_id: block.id,
        name: definition?.name ?? block.name, ...(definition?.namespace ? { namespace: definition.namespace } : {}),
        ...(custom ? { input: block.input.input } : { arguments: JSON.stringify(block.input) }), status: 'completed' };
    }
    return { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: block.text ?? '', annotations: [] }] };
  });
  const incomplete = message.stop_reason === 'max_tokens';
  const result = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : 'completed', model: body.model, output,
    error: null, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, usage: { input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0,
      total_tokens: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0) } };
  const headers = { 'x-chatgptweb-engine': compact ? 'text-compaction' : 'text-fallback', 'cache-control': 'no-store', 'x-magpie-sign-in': 'kept' };
  if (body.stream === false) return Response.json(result, { headers });
  function* events() {
    yield { type: 'response.created', response: { ...result, status: 'in_progress', output: [], usage: null } };
    yield { type: 'response.in_progress', response: { ...result, status: 'in_progress', output: [], usage: null } };
    for (const [output_index, item] of output.entries()) {
      yield { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : item.type === 'function_call' ? { arguments: '' } : { input: '' }) } };
      if (item.type === 'message') {
        const part = item.content[0];
        yield { type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0, part: { ...part, text: '' } };
        yield { type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: part.text };
        yield { type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: part.text };
        yield { type: 'response.content_part.done', item_id: item.id, output_index, content_index: 0, part };
      } else {
        const field = item.type === 'function_call' ? 'arguments' : 'input';
        const event = item.type === 'function_call' ? 'function_call_arguments' : 'custom_tool_call_input';
        yield { type: `response.${event}.delta`, item_id: item.id, output_index, delta: item[field] };
        yield { type: `response.${event}.done`, item_id: item.id, output_index, [field]: item[field] };
      }
      yield { type: 'response.output_item.done', output_index, item };
    }
    yield { type: incomplete ? 'response.incomplete' : 'response.completed', response: result };
  }
  const iterator = events(), encoder = new TextEncoder();
  let sequence = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (signal?.aborted) { controller.error(signal.reason); return; }
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify({ ...next.value, sequence_number: sequence++ })}\n\n`));
    },
    cancel() { iterator.return(); },
  }), { headers: { ...headers, 'content-type': 'text/event-stream' } });
}
