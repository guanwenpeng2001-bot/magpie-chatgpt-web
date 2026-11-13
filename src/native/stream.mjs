import { createHash } from 'node:crypto';

// When Magpie translates a Codex request (for example because it offers
// web_search), it offers custom tools, namespaced tools and tool_search as
// flat functions, and its decoder reads only function_call items back. The
// native daemon answers from the restored canonical request, so its calls are
// expressed in the shapes Magpie offered before the stream is handed back.
export function flatName(namespace, name) {
  const flat = `${namespace}__${name}`;
  if (Buffer.byteLength(flat) <= 64) return flat;
  const sum = createHash('sha256').update(`${namespace}\0${name}`).digest('hex').slice(0, 8);
  return `${Buffer.from(flat).subarray(0, 55).toString()}_${sum}`;
}

function offered(tools = []) {
  const functions = new Set(), custom = new Set();
  const visit = (list, namespace) => {
    for (const tool of Array.isArray(list) ? list : []) {
      if (!tool || typeof tool !== 'object') continue;
      if (tool.type === 'namespace') { visit(tool.tools, tool.name); continue; }
      const name = namespace ? flatName(namespace, tool.name) : tool.name;
      if (tool.type === 'function' && !namespace) functions.add(name);
      else if (tool.type === 'function' || tool.type === 'custom') custom.add(name);
      else if (tool.type === 'tool_search') custom.add('tool_search');
    }
  };
  return { visit, functions, custom };
}

export function wireTools(request) {
  const result = offered();
  result.visit(request?.tools);
  for (const item of Array.isArray(request?.input) ? request.input : []) if (Array.isArray(item?.tools)) result.visit(item.tools);
  return { functions: result.functions, custom: result.custom };
}

function wireName(item) {
  if (item.type === 'tool_search_call') return 'tool_search';
  return item.namespace ? flatName(item.namespace, item.name) : item.name;
}

function wireArguments(item) {
  if (item.type === 'custom_tool_call') return JSON.stringify({ input: item.input ?? '' });
  if (item.type === 'tool_search_call') return typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
  return item.arguments || '{}';
}

export function needsFlattening(item, wire) {
  if (!item || !['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) return false;
  if (item.type === 'function_call' && !item.namespace) return false;
  const name = wireName(item);
  return wire.functions.has(name) && !wire.custom.has(name);
}

function asFunctionCall(item, done) {
  return { type: 'function_call', id: item.id, call_id: item.call_id, name: wireName(item),
    arguments: done ? wireArguments(item) : '', status: done ? 'completed' : 'in_progress' };
}

export function createAdapter(wire) {
  const flattened = new Set();
  return event => {
    const item = event?.item;
    if (event?.type === 'response.output_item.added' && needsFlattening(item, wire)) {
      flattened.add(item.id);
      return [{ ...event, item: asFunctionCall(item, false) }];
    }
    if (event?.type === 'response.output_item.done' && needsFlattening(item, wire)) {
      const call = asFunctionCall(item, true);
      const added = flattened.has(item.id) ? [] : [{ type: 'response.output_item.added', output_index: event.output_index, item: asFunctionCall(item, false) }];
      flattened.delete(item.id);
      const args = item.type === 'function_call' ? [] : [
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: event.output_index, delta: call.arguments },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: event.output_index, arguments: call.arguments },
      ];
      return [...added, ...args, { ...event, item: call }];
    }
    if ((event?.type === 'response.custom_tool_call_input.delta' || event?.type === 'response.custom_tool_call_input.done') && flattened.has(event.item_id)) return [];
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event?.type) && Array.isArray(event.response?.output)) {
      const output = event.response.output.map(entry => needsFlattening(entry, wire) ? asFunctionCall(entry, true) : entry);
      return [{ ...event, response: { ...event.response, output } }];
    }
    return [event];
  };
}

function encode(event) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }

function adaptFrame(frame, adapt) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data || data === '[DONE]') return `${frame}\n\n`;
  let event;
  try { event = JSON.parse(data); } catch { return `${frame}\n\n`; }
  const adapted = adapt(event);
  return adapted.length === 1 && adapted[0] === event ? `${frame}\n\n` : adapted.map(encode).join('');
}

export function adaptResponsesStream(response, transformedRequest) {
  const wire = wireTools(transformedRequest);
  const type = response.headers.get('content-type') ?? '';
  if (!wire.functions.size || !response.ok || !response.body || !type.includes('text/event-stream')) return response;
  const adapt = createAdapter(wire);
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = '';
  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (frame.trim()) controller.enqueue(encoder.encode(adaptFrame(frame, adapt)));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) controller.enqueue(encoder.encode(adaptFrame(buffer, adapt)));
    },
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(response.body.pipeThrough(transform), { status: response.status, statusText: response.statusText, headers });
}
