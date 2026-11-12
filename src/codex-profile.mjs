#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PROFILE_NAME = 'chatgpt-web-http';
export const PROFILE_FILE = `${PROFILE_NAME}.config.toml`;
export const PROVIDER_ID = 'magpie';
export const MANAGED_MARKER = '# Managed by magpie-chatgpt-web; `--rollback` removes only files and settings it owns.';
export const JOURNAL_FILE = 'magpie-chatgpt-web-http.journal.json';
export const CONFIG_BACKUP_FILE = 'config.toml.magpie-chatgpt-web-http.bak';

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
    return { index, rawLine: lines[index], value: parseStringAssignment(lines[index]), boolean: parseBooleanAssignment(lines[index]) };
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
  return spans.length ? { lines: lines.slice(spans[0].index, spans.at(-1).end), table: spans[0] } : undefined;
}

export function readCodexRouting(text) {
  const { lines } = decodeDocument(String(text));
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  const provider = providerSpans(lines)[0];
  const providerLines = provider ? lines.slice(provider.index + 1, provider.end) : [];
  return {
    model: findAssignment(lines, 'model', 0, topEnd).value,
    modelProvider: findAssignment(lines, 'model_provider', 0, topEnd).value,
    modelCatalog: findAssignment(lines, 'model_catalog_json', 0, topEnd).value,
    openaiBaseUrl: findAssignment(lines, 'openai_base_url', 0, topEnd).value,
    magpieBaseUrl: findAssignment(providerLines, 'base_url').value,
    magpieEnvKey: findAssignment(providerLines, 'env_key').value,
    webSockets: findAssignment(providerLines, 'supports_websockets').boolean,
  };
}

export function resolveCodexHome({ env = process.env, home = homedir() } = {}) {
  const configured = String(env.CODEX_HOME ?? '').trim();
  return resolve(configured || join(home, '.codex'));
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
    '# CLI only. Codex Desktop uses --activate instead.',
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

export async function inspectCodexProfile({ codexHome = resolveCodexHome(), baseUrl, env = process.env, home = dirname(codexHome) } = {}) {
  if (env.HOME) home = resolve(env.HOME);
  const configPath = join(codexHome, 'config.toml');
  const profilePath = join(codexHome, PROFILE_FILE);
  const backupPath = `${profilePath}.bak`;
  let source;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing-config', configPath, profilePath, backupPath };
    throw error;
  }
  const routing = readCodexRouting(source);
  const catalogPath = await resolveModelCatalogPath({ configPath, codexHome, home });
  const configuredBaseUrl = normalizeUrl(baseUrl)
    || normalizeUrl(routing.magpieBaseUrl)
    || normalizeUrl(routing.openaiBaseUrl)
    || normalizeUrl(env.MAGPIE_ADDR ? gatewayUrl(env.MAGPIE_ADDR) : '')
    || await readGatewayAddress({ env, home });
  if (!configuredBaseUrl) return { status: 'missing-base-url', configPath, profilePath, backupPath, routing };
  let profile;
  try {
    profile = buildProfile(source, configuredBaseUrl, catalogPath);
  } catch (error) {
    return { status: 'missing-provider', detail: error.message, configPath, profilePath, backupPath, routing };
  }
  let current;
  try {
    current = await readFile(profilePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== undefined && !current.startsWith(`${MANAGED_MARKER}\n`)) {
    return { status: 'unmanaged-profile', configPath, profilePath, backupPath, baseUrl: configuredBaseUrl };
  }
  const status = current === undefined ? 'would-create' : current === profile ? 'ready' : 'would-update';
  return { status, changed: current !== profile, configPath, profilePath, backupPath, baseUrl: configuredBaseUrl, profile, routing };
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

export async function applyCodexProfile(options = {}) {
  const inspection = await inspectCodexProfile(options);
  if (!['would-create', 'would-update', 'ready'].includes(inspection.status)) return inspection;
  if (inspection.status === 'ready') return { ...inspection, status: 'ready', changed: false };
  if (inspection.status === 'would-update') {
    try {
      await copyFile(inspection.profilePath, inspection.backupPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  await atomicWrite(inspection.profilePath, inspection.profile);
  return { ...inspection, status: inspection.status === 'would-create' ? 'created' : 'updated', changed: true };
}

function topLevelInsert(lines) {
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  if (firstTable < 0) return lines.length;
  let index = firstTable;
  while (index > 0 && !lines[index - 1].trim()) index--;
  return Math.max(0, index);
}

function activationResult(source, catalogPath) {
  const document = decodeDocument(source);
  const provider = sourceProviderBlock(document.lines);
  if (!provider) return { status: 'missing-provider' };
  const firstTable = document.lines.findIndex(line => /^\s*\[/.test(line));
  const topEnd = firstTable < 0 ? document.lines.length : firstTable;
  const modelProvider = findAssignment(document.lines, 'model_provider', 0, topEnd);
  const contextWindow = findAssignment(document.lines, 'model_context_window', 0, topEnd);
  const compactLimit = findAssignment(document.lines, 'model_auto_compact_token_limit', 0, topEnd);
  const catalog = findAssignment(document.lines, 'model_catalog_json', 0, topEnd);
  const providerLines = document.lines.slice(provider.table.index + 1, provider.table.end);
  const webSockets = findAssignment(providerLines, 'supports_websockets');
  if (modelProvider.value !== undefined && modelProvider.value !== PROVIDER_ID) {
    return { status: 'conflict', detail: `model_provider is ${JSON.stringify(modelProvider.value)}` };
  }
  if (webSockets.boolean === true) return { status: 'conflict', detail: 'supports_websockets is already true' };
  if (!findAssignment(providerLines, 'base_url').value) return { status: 'missing-base-url' };

  const lines = document.lines.filter((_, index) => index !== contextWindow.index && index !== compactLimit.index);
  let currentModelProvider = findAssignment(lines, 'model_provider', 0, topLevelInsert(lines));
  if (currentModelProvider.index < 0) {
    lines.splice(topLevelInsert(lines), 0, `model_provider = ${JSON.stringify(PROVIDER_ID)}`);
    currentModelProvider = findAssignment(lines, 'model_provider', 0, topLevelInsert(lines));
  } else lines[currentModelProvider.index] = `model_provider = ${JSON.stringify(PROVIDER_ID)}`;
  if (catalogPath) {
    const currentCatalog = findAssignment(lines, 'model_catalog_json', 0, topLevelInsert(lines));
    const line = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
    if (currentCatalog.index < 0) lines.splice(topLevelInsert(lines), 0, line);
    else lines[currentCatalog.index] = line;
  }

  const shifted = sourceProviderBlock(lines);
  const shiftedTableEnd = lines.findIndex((line, index) => index > shifted.table.index && /^\s*\[/.test(line));
  const end = shiftedTableEnd < 0 ? lines.length : shiftedTableEnd;
  const currentWebSockets = findAssignment(lines, 'supports_websockets', shifted.table.index + 1, end);
  if (currentWebSockets.index < 0) lines.splice(shifted.table.index + 1, 0, 'supports_websockets = false');
  else lines[currentWebSockets.index] = 'supports_websockets = false';

  return {
    status: 'ok',
    text: renderDocument(document, lines),
    previous: {
      modelProvider: { present: modelProvider.index >= 0, rawLine: modelProvider.rawLine },
      webSockets: { present: webSockets.index >= 0, rawLine: webSockets.rawLine },
      contextWindow: { present: contextWindow.index >= 0, rawLine: contextWindow.rawLine },
      compactLimit: { present: compactLimit.index >= 0, rawLine: compactLimit.rawLine },
      catalog: { present: catalog.index >= 0, rawLine: catalog.rawLine },
    },
  };
}

async function resolveModelCatalogPath({ configPath, codexHome, home = homedir() }) {
  let source;
  try { source = await readFile(configPath, 'utf8'); }
  catch { return undefined; }
  const document = decodeDocument(source);
  const firstTable = document.lines.findIndex(line => /^\s*\[/.test(line));
  const configured = findAssignment(document.lines, 'model_catalog_json', 0, firstTable < 0 ? document.lines.length : firstTable).value;
  const candidates = configured && isAbsolute(configured)
    ? [configured]
    : configured
      ? [resolve(home, configured), resolve(codexHome, configured), resolve(dirname(configPath), configured), resolve(configured)]
      : [resolve(home, 'magpie-desktop-models.json'), resolve(codexHome, 'magpie-desktop-models.json')];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      JSON.parse(await readFile(candidate, 'utf8'));
      return resolve(candidate);
    } catch {}
  }
  return undefined;
}

async function readJournal(path) {
  try {
    const journal = JSON.parse(await readFile(path, 'utf8'));
    if (journal?.version !== 1 || journal.active !== true || typeof journal.configPath !== 'string') {
      throw new Error(`Invalid managed Codex route journal: ${path}`);
    }
    return journal;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function inspectActivatedCodexRoute({ codexHome = resolveCodexHome(), home = dirname(codexHome) } = {}) {
  const configPath = join(codexHome, 'config.toml');
  const journalPath = join(codexHome, JOURNAL_FILE);
  const backupPath = join(codexHome, CONFIG_BACKUP_FILE);
  let source;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing-config', configPath, journalPath, backupPath };
    throw error;
  }
  const journal = await readJournal(journalPath);
  if (journal && resolve(journal.configPath) !== resolve(configPath)) {
    return { status: 'conflict', detail: 'managed route journal belongs to another Codex config', configPath, journalPath, backupPath };
  }
  const catalogPath = await resolveModelCatalogPath({ configPath, codexHome, home });
  const result = activationResult(source, catalogPath);
  if (result.status !== 'ok') return { ...result, configPath, journalPath, backupPath };
  const pending = journal?.state === 'pending';
  const needsContextMigration = journal && journal.installed?.contextOverridesRemoved !== true;
  const contextDrift = result.previous.contextWindow.present || result.previous.compactLimit.present;
  if (journal && !needsContextMigration && contextDrift) {
    return {
      status: 'conflict',
      detail: 'context overrides were added after activation',
      configPath,
      journalPath,
      backupPath,
      journal,
    };
  }
  return {
    ...result,
    status: source === result.text ? (pending || needsContextMigration ? 'would-update' : 'ready') : journal ? 'would-update' : 'would-activate',
    changed: source !== result.text || pending || needsContextMigration,
    configPath,
    journalPath,
    backupPath,
    journal,
    catalogPath,
  };
}

async function ensureBackup(configPath, backupPath, source, activeJournal) {
  try {
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (!activeJournal && await readFile(backupPath, 'utf8') !== source) {
      throw new Error(`existing backup ${backupPath} does not match config.toml; refusing to continue`);
    }
  }
}

export async function activateCodexRoute({ codexHome = resolveCodexHome(), home = dirname(codexHome) } = {}) {
  const inspection = await inspectActivatedCodexRoute({ codexHome, home });
  if (inspection.status === 'ready') return { ...inspection, changed: false };
  if (!['would-activate', 'would-update'].includes(inspection.status)) return inspection;
  const source = await readFile(inspection.configPath, 'utf8');
  await ensureBackup(inspection.configPath, inspection.backupPath, source, inspection.journal);
  const journal = inspection.journal ? {
    ...inspection.journal,
    version: 1,
    active: true,
    configPath: inspection.configPath,
    backupPath: inspection.backupPath,
    previous: {
      ...inspection.journal.previous,
      ...(!inspection.journal.previous?.contextWindow ? { contextWindow: inspection.previous.contextWindow } : {}),
      ...(!inspection.journal.previous?.compactLimit ? { compactLimit: inspection.previous.compactLimit } : {}),
      ...(!inspection.journal.previous?.catalog ? { catalog: inspection.previous.catalog } : {}),
    },
    installed: {
      ...inspection.journal.installed,
      modelProvider: PROVIDER_ID,
      supportsWebSockets: false,
      contextOverridesRemoved: true,
      ...(!inspection.journal.installed?.catalogPath && inspection.catalogPath ? { catalogPath: inspection.catalogPath } : {}),
    },
  } : {
    version: 1,
    active: true,
    configPath: inspection.configPath,
    backupPath: inspection.backupPath,
    previous: inspection.previous,
    installed: {
      modelProvider: PROVIDER_ID,
      supportsWebSockets: false,
      contextOverridesRemoved: true,
      ...(inspection.catalogPath ? { catalogPath: inspection.catalogPath } : {}),
    },
  };
  await atomicWrite(inspection.journalPath, `${JSON.stringify({ ...journal, state: 'pending' }, null, 2)}\n`);
  await atomicWrite(inspection.configPath, inspection.text);
  await atomicWrite(inspection.journalPath, `${JSON.stringify({ ...journal, state: 'active' }, null, 2)}\n`);
  return { ...inspection, status: inspection.journal ? 'repaired' : 'activated', changed: true };
}

export async function repairActivatedCodexRoute(options = {}) {
  const journalPath = join(options.codexHome ?? resolveCodexHome(), JOURNAL_FILE);
  if (!await readJournal(journalPath)) return { status: 'inactive', changed: false };
  return activateCodexRoute(options);
}

function restoreOwnedAssignment(lines, key, current, previous) {
  if (current.index >= 0) {
    if (previous.present) lines[current.index] = previous.rawLine;
    else lines.splice(current.index, 1);
  } else if (previous.present && ['model_provider', 'model_context_window', 'model_auto_compact_token_limit', 'model_catalog_json'].includes(key)) {
    lines.splice(topLevelInsert(lines), 0, previous.rawLine);
  }
}

export async function rollbackCodexRoute({ codexHome = resolveCodexHome() } = {}) {
  const configPath = join(codexHome, 'config.toml');
  const journalPath = join(codexHome, JOURNAL_FILE);
  const backupPath = join(codexHome, CONFIG_BACKUP_FILE);
  const journal = await readJournal(journalPath);
  if (!journal) return { status: 'inactive', changed: false, configPath, journalPath, backupPath };
  const source = await readFile(configPath, 'utf8');
  const document = decodeDocument(source);
  const firstTable = document.lines.findIndex(line => /^\s*\[/.test(line));
  const topEnd = firstTable < 0 ? document.lines.length : firstTable;
  const modelProvider = findAssignment(document.lines, 'model_provider', 0, topEnd);
  const contextWindow = findAssignment(document.lines, 'model_context_window', 0, topEnd);
  const compactLimit = findAssignment(document.lines, 'model_auto_compact_token_limit', 0, topEnd);
  const catalog = findAssignment(document.lines, 'model_catalog_json', 0, topEnd);
  const previous = {
    modelProvider: { present: false },
    webSockets: { present: false },
    contextWindow: { present: false },
    compactLimit: { present: false },
    catalog: { present: false },
    ...journal.previous,
  };
  if (journal.state === 'pending' && !previous.catalog.present && catalog.index >= 0) {
    previous.catalog = { present: true, rawLine: catalog.rawLine };
  }
  const provider = providerSpans(document.lines)[0];
  if (!provider) return { status: 'conflict', changed: false, detail: 'Magpie provider table is missing', configPath, journalPath, backupPath };
  const providerLines = document.lines.slice(provider.index + 1, provider.end);
  const webSockets = findAssignment(providerLines, 'supports_websockets');
  if (modelProvider.value !== undefined && modelProvider.value !== PROVIDER_ID) {
    return { status: 'conflict', changed: false, detail: 'model_provider changed after activation', configPath, journalPath, backupPath };
  }
  const unchangedPending = (current, recorded) => current.index >= 0 &&
    recorded.present && current.rawLine === recorded.rawLine;
  if ((contextWindow.index >= 0 && !unchangedPending(contextWindow, previous.contextWindow)) ||
      (compactLimit.index >= 0 && !unchangedPending(compactLimit, previous.compactLimit))) {
    return { status: 'conflict', changed: false, detail: 'context overrides changed after activation', configPath, journalPath, backupPath };
  }
  const installedCatalog = journal.installed?.catalogPath
    ? `model_catalog_json = ${JSON.stringify(journal.installed.catalogPath)}`
    : undefined;
  if (journal.state !== 'pending' && catalog.index >= 0 && !unchangedPending(catalog, previous.catalog) && catalog.rawLine !== installedCatalog) {
    return { status: 'conflict', changed: false, detail: 'model catalog changed after activation', configPath, journalPath, backupPath };
  }
  if (webSockets.boolean === true) {
    return { status: 'conflict', changed: false, detail: 'supports_websockets changed to true after activation', configPath, journalPath, backupPath };
  }

  const lines = [...document.lines];
  const currentTopEnd = lines.findIndex(line => /^\s*\[/.test(line));
  restoreOwnedAssignment(
    lines,
    'model_provider',
    findAssignment(lines, 'model_provider', 0, currentTopEnd < 0 ? lines.length : currentTopEnd),
    previous.modelProvider,
  );
  const restoredProvider = providerSpans(lines)[0];
  const restoredEnd = lines.findIndex((line, index) => index > restoredProvider.index && /^\s*\[/.test(line));
  restoreOwnedAssignment(
    lines,
    'supports_websockets',
    findAssignment(lines, 'supports_websockets', restoredProvider.index + 1, restoredEnd < 0 ? lines.length : restoredEnd),
    previous.webSockets,
  );
  let restoredTopEnd = lines.findIndex(line => /^\s*\[/.test(line));
  if (restoredTopEnd < 0) restoredTopEnd = lines.length;
  restoreOwnedAssignment(lines, 'model_auto_compact_token_limit',
    findAssignment(lines, 'model_auto_compact_token_limit', 0, restoredTopEnd), previous.compactLimit);
  restoredTopEnd = lines.findIndex(line => /^\s*\[/.test(line));
  if (restoredTopEnd < 0) restoredTopEnd = lines.length;
  restoreOwnedAssignment(lines, 'model_context_window',
    findAssignment(lines, 'model_context_window', 0, restoredTopEnd), previous.contextWindow);
  restoredTopEnd = lines.findIndex(line => /^\s*\[/.test(line));
  if (restoredTopEnd < 0) restoredTopEnd = lines.length;
  restoreOwnedAssignment(lines, 'model_catalog_json',
    findAssignment(lines, 'model_catalog_json', 0, restoredTopEnd), previous.catalog);
  await atomicWrite(configPath, renderDocument(document, lines));
  await rm(journalPath, { force: true });
  await rm(backupPath, { force: true });
  return { status: 'deactivated', changed: true, configPath, journalPath, backupPath };
}

export async function rollbackCodexProfile({ codexHome = resolveCodexHome() } = {}) {
  const route = await rollbackCodexRoute({ codexHome });
  if (route.status === 'conflict') return route;
  const profilePath = join(codexHome, PROFILE_FILE);
  const backupPath = `${profilePath}.bak`;
  let current;
  try {
    current = await readFile(profilePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...route, status: route.changed ? 'rolled-back' : 'already-absent', profilePath, backupPath };
    throw error;
  }
  if (!current.startsWith(`${MANAGED_MARKER}\n`)) return { status: 'unmanaged-profile', changed: false, profilePath, backupPath };
  await rm(profilePath);
  await rm(backupPath, { force: true });
  return { ...route, status: 'rolled-back', changed: true, profilePath, backupPath };
}

function usage() {
  return [
    'usage: node src/codex-profile.mjs [--check | --apply | --activate | --rollback] [options]',
    '',
    'Create an HTTP-only Codex provider profile or activate the main Desktop route.',
    '  --check              compare without writing (default)',
    '  --apply              create or update the CLI profile',
    '  --activate           journal and select model_provider = "magpie" in config.toml',
    '  --rollback           restore the journalled route and remove the CLI profile',
    '  --codex-home <path>  override CODEX_HOME',
    '  --base-url <url>     override the profile provider base URL',
    '  --json               print a machine-readable result',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean' }, apply: { type: 'boolean' }, activate: { type: 'boolean' }, rollback: { type: 'boolean' },
      'codex-home': { type: 'string' }, 'base-url': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return { exitCode: 0, output: usage() };
  const modes = [values.check, values.apply, values.activate, values.rollback].filter(Boolean).length;
  if (modes > 1) throw new Error('choose one of --check, --apply, --activate or --rollback');
  const codexHome = values['codex-home'] ? resolve(values['codex-home']) : resolveCodexHome({ env });
  const base = { codexHome, baseUrl: values['base-url'], env };
  const result = values.rollback
    ? await rollbackCodexProfile({ codexHome })
    : values.activate
      ? await activateCodexRoute({ codexHome })
      : values.apply
        ? await applyCodexProfile(base)
        : await inspectCodexProfile(base);
  if (values.json) {
    const printable = { ...result };
    for (const key of ['profile', 'routing', 'text', 'previous']) delete printable[key];
    return { exitCode: values.check && result.changed ? 1 : 0, output: JSON.stringify(printable) };
  }
  const lines = [`codex provider: ${result.status}`, `main config: ${result.configPath ?? join(codexHome, 'config.toml')}`];
  if (result.profilePath) lines.push(`CLI profile: ${result.profilePath}`);
  if (result.journalPath) lines.push(`route journal: ${result.journalPath}`);
  if (result.status === 'would-create' || result.status === 'would-update') lines.push('next: npm run codex-profile -- --apply');
  if (result.status === 'would-activate') lines.push('next: npm run codex-profile -- --activate');
  if (result.status === 'activated' || result.status === 'repaired') lines.push('restart Codex Desktop so it reloads config.toml');
  if (result.status === 'rolled-back' || result.status === 'deactivated') lines.push('rollback complete; restart Codex Desktop');
  if (result.status === 'conflict' || result.status === 'unmanaged-profile') lines.push(`refused: ${result.detail ?? 'the target is not owned by this helper'}`);
  return {
    exitCode: ['conflict', 'unmanaged-profile'].includes(result.status) ? 2 : values.check && result.changed ? 1 : 0,
    output: lines.join('\n'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main();
    console.log(result.output);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`codex provider: ${error?.message ?? error}`);
    process.exitCode = 2;
  }
}
