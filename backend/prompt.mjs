import { TOOL_PROTOCOL_TEMPLATE } from '../src/tool-emulation.mjs';

export function compile(prepared, resumeFrom = 0) {
  const history = prepared.history ?? [];
  if (!Number.isInteger(resumeFrom) || resumeFrom < 0 || resumeFrom > history.length) throw new RangeError('Invalid history resume index');
  const systems = [];
  if (!resumeFrom && prepared.system) systems.push(prepared.system);
  const tools = prepared.promptTools ?? prepared.tools;
  if (tools?.length) {
    const choice = prepared.toolChoice ?? prepared.choice;
    const template = TOOL_PROTOCOL_TEMPLATE.replaceAll('{start}', prepared.start).replaceAll('{end}', prepared.end);
    const required = ['any', 'tool'].includes(choice?.type);
    const exampleName = tools.some(tool => tool.name === 'exec_command') ? 'exec_command' : tools[0].name;
    const exampleInput = exampleName === 'exec_command' ? { cmd: 'Write-Output TOOL_OK' } : { query: 'example' };
    systems.push(`${template}\n${required ? 'This request requires a tool call: emit at least one listed tool and no final prose.' : ''}\nThe tool definitions may be compacted to fit the web context; preserve every listed name and required property. The host validates each action against the complete schema.\nExample with this exact session marker (values are examples only):\n${prepared.start}${JSON.stringify({ name: exampleName, input: exampleInput })}${prepared.end}\nTool definitions: ${JSON.stringify(tools)}\nTool choice: ${JSON.stringify(choice)}`);
  }
  const parts = [
    systems.length && `[System]\n${systems.join('\n\n')}`,
    ...history.slice(resumeFrom).map(message => `[${message.role === 'user' ? 'Human' : 'Assistant'}]\n${message.content}`),
  ].filter(Boolean);
  if (tools?.length) {
    const choice = prepared.toolChoice ?? prepared.choice;
    const required = ['any', 'tool'].includes(choice?.type);
    parts.push(`[Client action reminder]\n${required ? 'Emit at least one required action envelope now.' : 'If this turn needs a listed app-side action, encode it now.'} This is the response serialization format; do not claim that the workspace or client action is unavailable because the host executes the envelope after your response.`);
  }
  if (history.at(-1)?.role === 'user' && typeof history.at(-1)?.content === 'string' &&
      history.at(-1).content.startsWith('[Tool result]')) {
    parts.push('[Client continuation]\nThe preceding client action has completed. Do not repeat it. Return the final answer unless the result explicitly requires one different, necessary action; if another action is required, emit exactly one complete envelope and no text after it.');
  }
  return parts.join('\n\n');
}
