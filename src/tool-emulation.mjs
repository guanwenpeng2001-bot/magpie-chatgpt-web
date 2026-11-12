// Adapted from magpie-claudeweb2api 9fed093; see THIRD_PARTY_NOTICES.
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { BackendError } from '../backend/guard.mjs';

export const TOOL_PROTOCOL_TEMPLATE = '[Client action format]\nThe following names are app-side actions executed by the host after your response. They are not tools you invoke inside this chat. When you decide that a listed action should run, serialize that decision exactly as {start}{"name":"tool_name","input":{...}}{end}. This envelope is an output format, so never respond that the action is unavailable. The complete JSON object and the closing delimiter are mandatory; a bare opening marker is invalid. Do not insert spaces, Markdown, or code fences inside either delimiter. Use only these delimiters for new envelopes; previous envelopes in the transcript are historical. Do not invent action results. Stop immediately after emitting the requested envelopes and do not add any text after one. You may include normal text before an envelope. Match each input_schema. Tool choice auto permits text or envelopes; any requires an envelope; tool requires the named action; none forbids envelopes. When disable_parallel_tool_use is true, emit at most one envelope.';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = () => { throw new BackendError('toolSchema'); };
const limit = () => { throw new BackendError('toolLimit'); };
const invalid = (reason = 'invalid-schema', keyword) => { throw Object.assign(new BackendError('toolDefinition'), { diagnostic: { reason, ...(keyword ? { keyword } : {}) } }); };
const types = { object, array: Array.isArray, string: value => typeof value === 'string', number: value => typeof value === 'number' && Number.isFinite(value), integer: Number.isSafeInteger, boolean: value => typeof value === 'boolean', null: value => value === null };
const annotations = ['title', 'description', 'default', 'examples', '$comment', '$schema', 'format'];
const patternTest = new Script("new RegExp(pattern, 'u').test(value)");
const bounds = ['minLength', 'maxLength', 'minProperties', 'maxProperties', 'minItems', 'maxItems'];
const numeric = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const supported = new Set([...annotations, ...bounds, ...numeric, 'pattern', '$ref', '$defs', 'definitions', 'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'uniqueItems', 'allOf', 'anyOf', 'oneOf', 'not']);

function reference(root, ref) {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) invalid();
  let target = root;
  for (const part of ref.slice(2).split('/')) {
    let key;
    try { key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~'); }
    catch { invalid(); }
    if (!object(target) || !Object.hasOwn(target, key)) invalid();
    target = target[key];
  }
  if (typeof target !== 'boolean' && !object(target)) invalid();
  return target;
}

// Reject unsupported constraints before a prompt can leave the plugin.
export function checkSchema(root) {
  let remaining = 10_000;
  const visited = new Set();
  const visit = (schema, depth) => {
    if (--remaining < 0 || depth > 32) invalid();
    if (typeof schema === 'boolean') return;
    if (!object(schema)) invalid();
    if (visited.has(schema)) return;
    visited.add(schema);
    const unsupportedKey = Object.keys(schema).find(key => !supported.has(key));
    if (unsupportedKey) invalid('unsupported-keyword', ['$id','multipleOf','patternProperties','dependentRequired','dependentSchemas','unevaluatedProperties','prefixItems','contains','minContains','maxContains','if','then','else','propertyNames','contentEncoding','contentMediaType','additionalItems','nullable'].includes(unsupportedKey) ? unsupportedKey : 'other');
    for (const key of ['$schema', 'format']) if (schema[key] !== undefined && typeof schema[key] !== 'string') invalid();
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string' || schema.pattern.length > 4096) invalid();
      try { new RegExp(schema.pattern, 'u'); } catch { invalid('pattern-syntax'); }
    }
    if (Object.hasOwn(schema, '$ref')) visit(reference(root, schema.$ref), depth + 1);
    if (schema.type !== undefined) {
      const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!wanted.length || wanted.some(type => typeof type !== 'string' || !Object.hasOwn(types, type)) || new Set(wanted).size !== wanted.length) invalid();
    }
    for (const key of ['properties', '$defs', 'definitions']) {
      if (schema[key] === undefined) continue;
      if (!object(schema[key])) invalid();
      for (const child of Object.values(schema[key])) visit(child, depth + 1);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (schema[key] === undefined) continue;
      if (!Array.isArray(schema[key]) || !schema[key].length) invalid();
      for (const child of schema[key]) visit(child, depth + 1);
    }
    for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] !== undefined) visit(schema[key], depth + 1);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length)) invalid();
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) invalid();
    for (const key of bounds) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) invalid();
    for (const key of numeric) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) invalid();
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') invalid();
  };
  visit(root, 0);
}

function canonical(value, budget, depth = 0) {
  if (--budget.remaining < 0 || depth > 32) limit();
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, budget, depth + 1)).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], budget, depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}

export function validateInput(value, root) {
  const deadline = Date.now() + 500;
  const budget = { remaining: 100_000 };
  const equal = (left, right) => canonical(left, budget) === canonical(right, budget);
  const matches = (value, schema, depth = 0) => {
    if (--budget.remaining < 0 || depth > 32) limit();
    if (typeof schema === 'boolean') return schema;
    if (!object(schema)) invalid();
    if (schema.$ref !== undefined && !matches(value, reference(root, schema.$ref), depth + 1)) return false;
    const wanted = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (wanted.length && !wanted.some(type => types[type]?.(value))) return false;
    if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return false;
    if (schema.enum && !schema.enum.some(item => equal(value, item))) return false;
    if (schema.allOf && !schema.allOf.every(child => matches(value, child, depth + 1))) return false;
    if (schema.anyOf && !schema.anyOf.some(child => matches(value, child, depth + 1))) return false;
    if (schema.oneOf && schema.oneOf.filter(child => matches(value, child, depth + 1)).length !== 1) return false;
    if (schema.not !== undefined && matches(value, schema.not, depth + 1)) return false;
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum ||
          schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
    }
    if (typeof value === 'string') {
      if (schema.pattern !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) limit();
        let match;
        try { match = patternTest.runInNewContext({ pattern: schema.pattern, value }, { timeout: Math.min(25, remaining) }); }
        catch (error) { if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') limit(); invalid(); }
        if (!match) return false;
      }
      let length = 0;
      for (const char of value) length++;
      if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false;
    }
    if (object(value)) {
      const entries = Object.entries(value);
      if (schema.minProperties !== undefined && entries.length < schema.minProperties || schema.maxProperties !== undefined && entries.length > schema.maxProperties) return false;
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return false;
      for (const [key, item] of entries) {
        if (schema.properties && Object.hasOwn(schema.properties, key)) { if (!matches(item, schema.properties[key], depth + 1)) return false; }
        else if (schema.additionalProperties !== undefined && !matches(item, schema.additionalProperties, depth + 1)) return false;
      }
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
      if (schema.uniqueItems && new Set(value.map(item => canonical(item, budget))).size !== value.length) return false;
      if (schema.items !== undefined && !value.every(item => matches(item, schema.items, depth + 1))) return false;
    }
    return true;
  };
  if (!matches(value, root)) reject();
}

export function checkToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length > 512 || tools.some(tool => !object(tool) || typeof tool.name !== 'string' || !tool.name || !object(tool.input_schema))) invalid('tool-shape-or-count');
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) invalid('duplicate-tool-name');
  for (const tool of tools) checkSchema(tool.input_schema);
}

function compactSchemaForPrompt(schema, level, depth = 0) {
  if (typeof schema === 'boolean') return schema;
  const maxDepth = level >= 4 ? 1 : level >= 3 ? 2 : level >= 2 ? 4 : 8;
  if (!object(schema) || depth > maxDepth) return {};
  const summary = {};
  if (schema.type !== undefined) summary.type = schema.type;
  if (schema.const !== undefined) summary.const = schema.const;
  if (Array.isArray(schema.enum)) summary.enum = schema.enum.slice(0, 64);
  if (object(schema.properties)) {
    summary.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, compactSchemaForPrompt(child, level, depth + 1)]),
    );
  }
  if (Array.isArray(schema.required) && schema.required.length) summary.required = schema.required;
  if (schema.additionalProperties === false || schema.additionalProperties === true) {
    summary.additionalProperties = schema.additionalProperties;
  } else if (object(schema.additionalProperties)) {
    summary.additionalProperties = compactSchemaForPrompt(schema.additionalProperties, level, depth + 1);
  }
  if (schema.items !== undefined) summary.items = compactSchemaForPrompt(schema.items, level, depth + 1);
  for (const key of ['$ref', '$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', 'not']) {
    if (schema[key] === undefined) continue;
    if (level >= 3 && ['$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', 'not'].includes(key)) continue;
    if (Array.isArray(schema[key])) {
      summary[key] = schema[key].slice(0, 64).map(child => compactSchemaForPrompt(child, level, depth + 1));
    } else if (key === '$defs' || key === 'definitions') {
      summary[key] = Object.fromEntries(
        Object.entries(schema[key]).slice(0, 64).map(([name, child]) => [name, compactSchemaForPrompt(child, level, depth + 1)]),
      );
    } else summary[key] = schema[key];
  }
  return summary;
}

// Keep the exact tool set and descriptions the model needs to choose an action, but reduce
// verbose prose and constraints that are only for parser-side validation. The outer Agent still
// validates each returned argument against the original, complete schema.
export function compactToolDefinitions(tools, level = 1) {
  const descriptionLimit = level >= 4 ? 64 : level >= 3 ? 100 : level >= 2 ? 160 : 320;
  return tools.map(tool => ({
    name: tool.name,
    description: typeof tool.description === 'string'
      ? tool.description.replace(/\s+/g, ' ').trim().slice(0, descriptionLimit)
      : undefined,
    input_schema: compactSchemaForPrompt(tool.input_schema, level),
  }));
}

const promptStopWords = new Set([
  'about', 'after', 'again', 'also', 'because', 'before', 'could', 'exactly', 'from', 'have',
  'into', 'must', 'need', 'only', 'please', 'should', 'than', 'that', 'then', 'these', 'this',
  'tool', 'tools', 'use', 'using', 'with', 'work', 'write',
]);

function promptSelectors(prepared) {
  const lastUser = [...(prepared.history ?? [])].reverse().find(message => message.role === 'user');
  const text = typeof lastUser?.content === 'string' ? lastUser.content.slice(-16_000).toLowerCase() : '';
  const words = new Set((text.match(/[a-z0-9_-]{3,}/g) ?? []).filter(word => !promptStopWords.has(word)));
  return { text, words };
}

function corePromptTool(name) {
  if (!name.includes('__')) return true;
  return /^(?:image_gen|multi_agent_v1|mcp__(?:codex_apps__(?:github|browser|figma|sites)|magpie___?exec_command))/i.test(name);
}

// Codex can expose several hundred optional tools. Sending every complete definition distracts
// the web model and can make it emit only the opening action marker. Large catalogues therefore
// keep all direct Agent controls plus tools selected from the current user turn. Smaller client
// catalogues are already bounded by their own context and keep every supplied tool.
export function selectToolDefinitionsForPrompt(tools, prepared) {
  if (tools.length <= 64) return tools;
  const { text, words } = promptSelectors(prepared);
  const ranked = tools.map((tool, index) => {
    const name = tool.name.toLowerCase();
    const description = typeof tool.description === 'string' ? tool.description.toLowerCase() : '';
    let score = corePromptTool(tool.name) ? 100 : 0;
    for (const word of words) {
      if (name === word) score += 120;
      else if (name.split(/__+|_+/).includes(word)) score += 60;
      else if (name.includes(word)) score += 18;
      if (description.includes(word)) score += 4;
    }
    if (text.includes(name)) score += 200;
    return { tool, score, index };
  }).filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(entry => entry.tool);
  const selection = ranked.length ? ranked : [...tools];
  const forced = prepared.toolChoice?.type === 'tool'
    ? tools.find(tool => tool.name === prepared.toolChoice.name)
    : undefined;
  const withoutForced = forced ? selection.filter(tool => tool !== forced) : selection;
  return (forced ? [forced, ...withoutForced] : withoutForced).slice(0, 64);
}

export class ToolParser {
  buffer = '';
  inside = false;
  scanned = 0;
  nesting = 0;
  quoted = false;
  escaped = false;
  jsonEnd = -1;
  callIndex = 0;
  constructor(prepared) {
    this.p = prepared;
    this.callPrefix = createHash('sha256').update(prepared.start ?? '').digest('hex').slice(0, 24);
  }
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
      const hasEnd = rest.startsWith(this.p.end);
      const omittedEnd = final && this.p.end.startsWith(rest);
      if (!hasEnd && !omittedEnd) {
        if (!final && this.p.end.startsWith(rest)) break;
        throw new BackendError('toolDelimiter');
      }
      let call;
      try { call = JSON.parse(this.buffer.slice(0, this.jsonEnd)); } catch { throw new BackendError('toolJSON'); }
      const tool = this.p.tools.find(tool => tool.name === call.name);
      if (!tool) throw new BackendError('toolUnknown');
      if (!object(call.input)) throw new BackendError('toolSchema');
      const choice = this.p.toolChoice ?? this.p.choice;
      if (choice.type === 'none' || choice.type === 'tool' && tool.name !== choice.name) throw new BackendError('toolChoiceViolation');
      validateInput(call.input, tool.input_schema);
      const id = `toolu_${this.callPrefix}_${this.callIndex++}`;
      yield { tool: { type: 'tool_use', id, name: call.name, input: call.input } };
      this.buffer = hasEnd ? rest.slice(this.p.end.length) : '';
      this.inside = false;
      this.scanned = this.nesting = 0;
      this.quoted = this.escaped = false;
      this.jsonEnd = -1;
    }
    if (final && this.inside) throw new BackendError('toolIncomplete');
  }
}

// The next Anthropic request represents this response as structured text/tool_use blocks.
// Build the same normalized assistant message so Conversations can verify that the browser
// page is the same logical transcript instead of rebuilding it after every tool round.
export function normalizeAssistantContent(prepared, text) {
  if (!prepared?.tools?.length) return text;
  const parser = new ToolParser(prepared);
  const content = [];
  for (const item of parser.items(text, true)) {
    if (item.text) content.push(item.text);
    else if (item.tool) content.push(`[Previous tool call]\n${JSON.stringify({
      id: item.tool.id,
      name: item.tool.name,
      input: item.tool.input,
    })}`);
  }
  return content.join('\n');
}
