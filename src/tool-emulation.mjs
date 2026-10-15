// Adapted from magpie-claudeweb2api 9fed093; see THIRD_PARTY_NOTICES.
import { randomUUID } from 'node:crypto';
import { BackendError } from '../backend/guard.mjs';

export const TOOL_PROTOCOL_TEMPLATE = '[Tool protocol]\nTools are executed by the client. To request a tool, emit {start}{"name":"tool_name","input":{...}}{end}. Use only these delimiters for new calls; previous calls in the transcript are historical. Do not invent tool results. Stop after emitting the requested calls. You may include normal text outside calls. Match each input_schema. Tool choice auto permits text or calls; any requires a call; tool requires the named tool; none forbids calls. When disable_parallel_tool_use is true, emit at most one call.';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = () => { throw new BackendError('toolSchema'); };
const limit = () => { throw new BackendError('toolLimit'); };
const invalid = () => { throw new BackendError('toolDefinition'); };
const types = { object, array: Array.isArray, string: value => typeof value === 'string', number: value => typeof value === 'number' && Number.isFinite(value), integer: Number.isSafeInteger, boolean: value => typeof value === 'boolean', null: value => value === null };
const annotations = ['title', 'description', 'default', 'examples', '$comment'];
const bounds = ['minLength', 'maxLength', 'minProperties', 'maxProperties', 'minItems', 'maxItems'];
const numeric = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const supported = new Set([...annotations, ...bounds, ...numeric, '$ref', '$defs', 'definitions', 'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'uniqueItems', 'allOf', 'anyOf', 'oneOf', 'not']);

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
    if (Object.keys(schema).some(key => !supported.has(key))) invalid();
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
  if (!Array.isArray(tools) || tools.length > 128 || tools.some(tool => !object(tool) || typeof tool.name !== 'string' || !tool.name || !object(tool.input_schema))) invalid();
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) invalid();
  for (const tool of tools) checkSchema(tool.input_schema);
}

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
      const choice = this.p.toolChoice ?? this.p.choice;
      if (choice.type === 'none' || choice.type === 'tool' && tool.name !== choice.name) throw new BackendError('toolChoiceViolation');
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
