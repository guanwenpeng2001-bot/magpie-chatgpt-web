export function parseSSE(chunk, buffer = '') {
  const input = buffer + chunk;
  const events = [];
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  for (const match of input.matchAll(boundary)) {
    let event = '';
    const data = [];
    for (const line of input.slice(start, match.index).split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
    start = match.index + match[0].length;
  }
  return { events, rest: input.slice(start) };
}

export function encodeSSE({ event, data }) {
  if (event && /[\r\n]/.test(event)) throw new TypeError('SSE event names cannot contain newlines');
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : '') + text.split(/\r\n|\r|\n/).map(line => `data: ${line}\n`).join('') + '\n';
}
