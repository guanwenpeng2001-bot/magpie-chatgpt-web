import { TOOL_PROTOCOL_TEMPLATE } from '../src/tool-emulation.mjs';

export function compile(prepared, resumeFrom = 0) {
  const history = prepared.history ?? [];
  if (!Number.isInteger(resumeFrom) || resumeFrom < 0 || resumeFrom > history.length) throw new RangeError('Invalid history resume index');
  const parts = [
    !resumeFrom && prepared.system && `[System]\n${prepared.system}`,
    ...history.slice(resumeFrom).map(message => `[${message.role === 'user' ? 'Human' : 'Assistant'}]\n${message.content}`),
  ].filter(Boolean);
  if (prepared.tools?.length) {
    const choice = prepared.toolChoice ?? prepared.choice;
    const template = TOOL_PROTOCOL_TEMPLATE.replaceAll('{start}', prepared.start).replaceAll('{end}', prepared.end);
    parts.push(`${template}\nTool definitions: ${JSON.stringify(prepared.tools)}\nTool choice: ${JSON.stringify(choice)}`, '[Assistant]\n');
  }
  return parts.join('\n\n');
}
