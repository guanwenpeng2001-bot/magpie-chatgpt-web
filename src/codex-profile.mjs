#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PROFILE_NAME = 'chatgpt-web-http';
export const PROFILE_FILE = `${PROFILE_NAME}.config.toml`;
export const NATIVE_PROFILE_NAME = 'chatgpt-web-native';
export const NATIVE_PROFILE_FILE = `${NATIVE_PROFILE_NAME}.config.toml`;
export const PROVIDER_ID = 'magpie';
export const MANAGED_MARKER = '# Managed by magpie-chatgpt-web; `--rollback` removes only this CLI profile.';
export const LEGACY_MANAGED_MARKER = '# Managed by magpie-chatgpt-web; `--rollback` removes only files and settings it owns.';

function isManagedProfile(content) {
  return content.startsWith(`${MANAGED_MARKER}\n`) || content.startsWith(`${LEGACY_MANAGED_MARKER}\n`);
}

function normalizeUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function nativeUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !/^\/backend-api\/codex\/?$/.test(url.pathname)) return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function gatewayUrl(addr) {
  const value = String(addr ?? '').trim();
  if (!value) return '';
  const url = /^[a-z]+:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
  if (url.pathname === '/' || !url.pathname) url.pathname = '/v1';
  return normalizeUrl(url);
}

function decodeDocument(text) {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const trailing = body.endsWith('\n');
  const lines = body.split(/\r?\n/);
  if (trailing) lines.pop();
  return { bom, eol, trailing, lines };
}

function renderDocument(document, lines = document.lines) {
  return `${document.bom ? '\uFEFF' : ''}${lines.join(document.eol)}${document.trailing ? document.eol : ''}`;
}

function parseStringAssignment(line) {
  const match = String(line).match(/^\s*[A-Za-z0-9_.-]+\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
  if (!match) return undefined;
  return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1);
}

function parseBooleanAssignment(line) {
  const match = String(line).match(/^\s*[A-Za-z0-9_.-]+\s*=\s*(true|false)\s*(?:#.*)?$/);
  return match ? match[1] === 'true' : undefined;
}

function findAssignment(lines, key, start = 0, end = lines.length) {
  const escaped = key.replaceAll('.', '\\.');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=`);
  for (let index = start; index < end; index++) {
    if (!pattern.test(lines[index])) continue;
    return {
      index,
      rawLine: lines[index],
      value: parseStringAssignment(lines[index]),
      boolean: parseBooleanAssignment(lines[index]),
    };
  }
  return { index: -1, rawLine: undefined, value: undefined, boolean: undefined };
}

function tableHeaders(lines) {
  const headers = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (match) headers.push({ name: match[1].trim(), index });
  }
  return headers;
}

function providerSpans(lines) {
  const target = `model_providers.${PROVIDER_ID}`;
  const headers = tableHeaders(lines);
  const exact = headers.filter(header => header.name === target);
  if (exact.length > 1) throw new Error(`Codex config contains more than one [${target}] table`);
  if (exact.length === 0) return [];
  const first = headers.findIndex(header => header.name === target);
  const spans = [];
  for (let index = first; index < headers.length; index++) {
    const header = headers[index];
    if (header.name !== target && !header.name.startsWith(`${target}.`)) break;
    spans.push({ ...header, end: headers[index + 1]?.index ?? lines.length });
  }
  return spans;
}

function sourceProviderBlock(lines) {
  const spans = providerSpans(lines);
  return spans.length
    ? { lines: lines.slice(spans[0].index, spans.at(-1).end), table: spans[0] }
    : undefined;
}

function setProviderBaseUrl(block, baseUrl) {
  if (!baseUrl) return block;
  const lines = [...block];
  const found = findAssignment(lines, 'base_url');
  const line = `base_url = ${JSON.stringify(baseUrl)}`;
  if (found.index >= 0) lines[found.index] = line;
  else lines.splice(1, 0, line);
  return lines;
}

function setProviderWebSockets(block) {
  const lines = [...block];
  const tableEnd = lines.findIndex((line, index) => index > 0 && /^\s*\[/.test(line));
  const found = findAssignment(lines, 'supports_websockets', 1, tableEnd < 0 ? lines.length : tableEnd);
  if (found.boolean === true) throw new Error('Codex already sets supports_websockets = true; refusing to override it');
  const line = 'supports_websockets = false';
  if (found.index < 0) lines.splice(1, 0, line);
  else lines[found.index] = line;
  return lines;
}

export function readCodexRouting(source) {
  const document = decodeDocument(String(source ?? ''));
  const firstTable = document.lines.findIndex(line => /^\s*\[/.test(line));
  const topEnd = firstTable < 0 ? document.lines.length : firstTable;
  const provider = sourceProviderBlock(document.lines);
  const providerLines = provider?.lines ?? [];
  return {
    model: findAssignment(document.lines, 'model', 0, topEnd).value,
    modelProvider: findAssignment(document.lines, 'model_provider', 0, topEnd).value,
    modelCatalog: findAssignment(document.lines, 'model_catalog_json', 0, topEnd).value,
    openaiBaseUrl: findAssignment(document.lines, 'openai_base_url', 0, topEnd).value,
    magpieBaseUrl: findAssignment(providerLines, 'base_url').value,
    magpieEnvKey: findAssignment(providerLines, 'env_key').value,
    webSockets: findAssignment(providerLines, 'supports_websockets').boolean,
  };
}

async function readGatewayAddress({ env = process.env, home = homedir() } = {}) {
  const configDir = resolve(String(env.MAGPIE_CONFIG_DIR ?? '').trim() || join(home, '.config', 'magpie'));
  try {
    const gateway = JSON.parse(await readFile(join(configDir, 'gateway.json'), 'utf8'));
    return gatewayUrl(gateway?.addr);
  } catch {
    return '';
  }
}

async function resolveModelCatalogPath({ configPath, codexHome, home = homedir(), native = false }) {
  let source;
  try { source = await readFile(configPath, 'utf8'); }
  catch { return undefined; }
  const document = decodeDocument(source);
  const firstTable = document.lines.findIndex(line => /^\s*\[/.test(line));
  const configured = findAssignment(
    document.lines,
    'model_catalog_json',
    0,
    firstTable < 0 ? document.lines.length : firstTable,
  ).value;
  const candidates = configured && isAbsolute(configured)
    ? [configured]
    : native
      ? [resolve(dirname(configPath), configured || 'magpie-desktop-models.json')]
    : configured
      ? [
          resolve(home, configured),
          resolve(codexHome, configured),
          resolve(dirname(configPath), configured),
          resolve(configured),
        ]
      : [
          resolve(home, 'magpie-desktop-models.json'),
          resolve(codexHome, 'magpie-desktop-models.json'),
        ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const catalog = JSON.parse(await readFile(candidate, 'utf8'));
      if (native && (!Array.isArray(catalog?.models) || catalog.models.length === 0)) continue;
      return resolve(candidate);
    } catch {}
  }
  return undefined;
}

function buildProfile(source, baseUrl, catalogPath) {
  const document = decodeDocument(source);
  const provider = sourceProviderBlock(document.lines);
  if (!provider) throw new Error(`Codex config has no [model_providers.${PROVIDER_ID}] table to preserve`);
  const firstTable = document.lines.findIndex(line => /^\s*\[/.test(line));
  const topEnd = firstTable < 0 ? document.lines.length : firstTable;
  const catalog = catalogPath ?? findAssignment(document.lines, 'model_catalog_json', 0, topEnd).value;
  const providerLines = setProviderWebSockets(setProviderBaseUrl(provider.lines, baseUrl));
  const lines = [
    MANAGED_MARKER,
    '# CLI only. Magpie owns the Desktop config.toml and model catalogue.',
    '# This profile deliberately uses the smallest Web transport ceiling for every routed mode.',
    '',
    `model_provider = "${PROVIDER_ID}"`,
    'model_context_window = 41000',
    'model_auto_compact_token_limit = 32768',
  ];
  if (catalog) lines.push(`model_catalog_json = ${JSON.stringify(catalog)}`);
  lines.push('', ...providerLines);
  return `${lines.join('\n')}\n`;
}

function buildNativeProfile(baseUrl, catalogPath) {
  return [
    MANAGED_MARKER,
    '# CLI only. Magpie owns the Desktop config.toml and model catalogue.',
    '# Built-in OpenAI preserves native message provenance. Model limits come from the catalogue/base config.',
    '',
    'model_provider = "openai"',
    `openai_base_url = ${JSON.stringify(baseUrl)}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    '',
  ].join('\n');
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function resolveCodexHome({ env = process.env, home = homedir() } = {}) {
  const configured = String(env.CODEX_HOME ?? '').trim();
  return resolve(configured || join(home, '.codex'));
}

export async function inspectCodexProfile({
  codexHome = resolveCodexHome(),
  baseUrl,
  native = false,
  env = process.env,
  home = dirname(codexHome),
} = {}) {
  if (env.HOME) home = resolve(env.HOME);
  const configPath = join(codexHome, 'config.toml');
  const profilePath = join(codexHome, native ? NATIVE_PROFILE_FILE : PROFILE_FILE);
  const backupPath = `${profilePath}.bak`;
  let source;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing-config', configPath, profilePath, backupPath,
      ...(native ? { detail: 'Native requires the existing Magpie-managed Codex config; connect Codex through Magpie first.' } : {}) };
    throw error;
  }
  const routing = readCodexRouting(source);
  const requestedNativeUrl = baseUrl !== undefined ? baseUrl : routing.openaiBaseUrl;
  const configuredBaseUrl = native ? nativeUrl(requestedNativeUrl) : normalizeUrl(baseUrl)
    || normalizeUrl(routing.magpieBaseUrl)
    || normalizeUrl(routing.openaiBaseUrl)
    || normalizeUrl(env.MAGPIE_ADDR ? gatewayUrl(env.MAGPIE_ADDR) : '')
    || await readGatewayAddress({ env, home });
  if (!configuredBaseUrl) return {
    status: native ? requestedNativeUrl === undefined ? 'missing-native-base-url' : 'invalid-native-base-url' : 'missing-base-url',
    ...(native ? { detail: 'Native requires openai_base_url or --base-url pointing to Magpie at http(s)://host[:port]/backend-api/codex, without credentials, query or fragment. A custom provider /v1 URL cannot preserve native provenance.' } : {}),
    configPath, profilePath, backupPath, routing,
  };
  const catalogPath = await resolveModelCatalogPath({ configPath, codexHome, home, native });
  if (native && !catalogPath) return {
    status: 'missing-native-catalog',
    detail: 'Native requires a readable JSON model catalogue with a non-empty models array. Check model_catalog_json or refresh the Codex model catalogue through Magpie.',
    configPath, profilePath, backupPath,
  };
  let profile;
  try {
    profile = native ? buildNativeProfile(configuredBaseUrl, catalogPath) : buildProfile(source, configuredBaseUrl, catalogPath);
  } catch (error) {
    return { status: 'missing-provider', detail: error.message, configPath, profilePath, backupPath, routing };
  }
  let current;
  try {
    current = await readFile(profilePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== undefined && !isManagedProfile(current)) {
    return { status: 'unmanaged-profile', configPath, profilePath, backupPath, baseUrl: configuredBaseUrl };
  }
  const status = current === undefined ? 'would-create' : current === profile ? 'ready' : 'would-update';
  return {
    status,
    changed: current !== profile,
    configPath,
    profilePath,
    backupPath,
    baseUrl: configuredBaseUrl,
    profile,
    routing,
  };
}

export async function applyCodexProfile(options = {}) {
  const inspection = await inspectCodexProfile(options);
  if (!['would-create', 'would-update'].includes(inspection.status)) return inspection;
  try {
    await copyFile(inspection.profilePath, inspection.backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error?.code !== 'EEXIST') throw error;
      await unlink(inspection.backupPath);
      await copyFile(inspection.profilePath, inspection.backupPath, fsConstants.COPYFILE_EXCL);
    }
  }
  await atomicWrite(inspection.profilePath, inspection.profile);
  return {
    ...inspection,
    status: inspection.status === 'would-create' ? 'created' : 'updated',
    changed: true,
  };
}

export async function rollbackCodexProfile({ codexHome = resolveCodexHome(), native = false } = {}) {
  const profilePath = join(codexHome, native ? NATIVE_PROFILE_FILE : PROFILE_FILE);
  const backupPath = `${profilePath}.bak`;
  let current;
  try {
    current = await readFile(profilePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'already-absent', changed: false, profilePath, backupPath };
    throw error;
  }
  if (!isManagedProfile(current)) {
    return { status: 'unmanaged-profile', changed: false, profilePath, backupPath };
  }
  await rm(profilePath);
  await rm(backupPath, { force: true });
  return { status: 'rolled-back', changed: true, profilePath, backupPath };
}

function usage() {
  return [
    'usage: node src/codex-profile.mjs [--check | --apply | --rollback] [options]',
    '',
    'Create an isolated Codex CLI profile. The main Codex Desktop config is owned by Magpie and is never modified.',
    `  --native             use built-in OpenAI for Native tools (${NATIVE_PROFILE_FILE}); omit generic context limits`,
    `                       run with: codex -p ${NATIVE_PROFILE_NAME}`,
    `                       without --native: generic HTTP profile (${PROFILE_FILE})`,
    '  --check              compare without writing (default)',
    '  --apply              create or update the CLI profile',
    '  --rollback           remove only the managed CLI profile',
    '  --codex-home <path>  override CODEX_HOME',
    '  --base-url <url>     override the profile provider base URL',
    '  --json               print a machine-readable result',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean' },
      apply: { type: 'boolean' },
      rollback: { type: 'boolean' },
      native: { type: 'boolean' },
      'codex-home': { type: 'string' },
      'base-url': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return { exitCode: 0, output: usage() };
  const modes = [values.check, values.apply, values.rollback].filter(Boolean).length;
  if (modes > 1) throw new Error('choose one of --check, --apply or --rollback');
  const codexHome = values['codex-home']
    ? resolve(values['codex-home'])
    : resolveCodexHome({ env });
  const result = values.rollback
    ? await rollbackCodexProfile({ codexHome, native: values.native })
    : values.apply
      ? await applyCodexProfile({ codexHome, baseUrl: values['base-url'], native: values.native, env })
      : await inspectCodexProfile({ codexHome, baseUrl: values['base-url'], native: values.native, env });
  const refused = ['conflict', 'unmanaged-profile'].includes(result.status)
    || (values.native && !['would-create', 'would-update', 'ready', 'created', 'updated', 'rolled-back', 'already-absent'].includes(result.status));
  const exitCode = refused ? 2 : values.check && result.changed ? 1 : 0;
  if (values.json) {
    const printable = { ...result };
    for (const key of ['profile', 'routing', 'text', 'previous']) delete printable[key];
    return { exitCode: values.native ? exitCode : values.check && result.changed ? 1 : 0, output: JSON.stringify(printable) };
  }
  const lines = [`codex CLI profile: ${result.status}`, `main config (read-only): ${result.configPath ?? join(codexHome, 'config.toml')}`];
  if (result.profilePath) lines.push(`CLI profile: ${result.profilePath}`);
  if (result.status === 'would-create' || result.status === 'would-update') lines.push(`next: npm run codex-profile -- ${values.native ? '--native ' : ''}--apply`);
  if (values.native && ['ready', 'created', 'updated'].includes(result.status)) lines.push(`run: codex -p ${NATIVE_PROFILE_NAME}`);
  if (refused) lines.push(`refused: ${result.detail ?? 'the target is not owned by this helper'}`);
  return {
    exitCode,
    output: lines.join('\n'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main();
    console.log(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`codex CLI profile: ${error?.message ?? error}`);
    process.exitCode = 2;
  }
}
