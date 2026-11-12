import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONFIG_BACKUP_FILE,
  JOURNAL_FILE,
  MANAGED_MARKER,
  PROFILE_FILE,
  activateCodexRoute,
  applyCodexProfile,
  inspectActivatedCodexRoute,
  inspectCodexProfile,
  readCodexRouting,
  repairActivatedCodexRoute,
  rollbackCodexRoute,
  rollbackCodexProfile,
} from '../src/codex-profile.mjs';

async function fixture(t, config = '') {
  const root = await mkdtemp(join(tmpdir(), 'codex-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex');
  const magpieHome = join(root, 'magpie');
  await mkdir(codexHome, { recursive: true });
  await mkdir(magpieHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), config);
  return { root, codexHome, magpieHome, env: { HOME: root, MAGPIE_CONFIG_DIR: magpieHome } };
}

const wiredConfig = `model = "chatgpt-web/gpt-6"
model_catalog_json = "magpie-desktop-models.json"
openai_base_url = "http://127.0.0.1:3999/backend-api/codex"

[model_providers.magpie]
name = "magpie"
base_url = "http://127.0.0.1:3999/v1"
wire_api = "responses"
env_key = "MAGPIE_API_KEY"
experimental_bearer_token = "fixture-bearer-token"
http_headers = { "x-openai-actor-authorization" = "magpie", "x-fixture" = "kept" }
requires_openai_auth = true
capabilities = { remote_compaction = "v2" }
`;

test('derives a provider-wide HTTP profile from Magpie wiring without a model list', async t => {
  const paths = await fixture(t, wiredConfig);
  const result = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(result.status, 'would-create');
  assert.equal(result.baseUrl, 'http://127.0.0.1:3999/v1');
  assert.equal(result.profile.includes(MANAGED_MARKER), true);
  assert.match(result.profile, /model_provider = "magpie"/);
  assert.match(result.profile, /supports_websockets = false/);
  assert.match(result.profile, /^model_context_window = 41000$/m);
  assert.match(result.profile, /^model_auto_compact_token_limit = 32768$/m);
  assert.match(result.profile, /env_key = "MAGPIE_API_KEY"/);
  assert.match(result.profile, /experimental_bearer_token = "fixture-bearer-token"/);
  assert.match(result.profile, /x-fixture" = "kept"/);
  assert.match(result.profile, /requires_openai_auth = true/);
  assert.match(result.profile, /capabilities = \{ remote_compaction = "v2" \}/);
  assert.match(result.profile, /model_catalog_json = "magpie-desktop-models.json"/);
  assert.doesNotMatch(result.profile, /^model =/m);
});

test('check mode never writes and apply is idempotent', async t => {
  const paths = await fixture(t, wiredConfig);
  const before = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
  const checked = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(checked.status, 'would-create');
  await assert.rejects(stat(join(paths.codexHome, PROFILE_FILE)), { code: 'ENOENT' });

  const first = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(first.status, 'created');
  const written = await readFile(join(paths.codexHome, PROFILE_FILE), 'utf8');
  assert.equal(written, checked.profile);
  const second = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(second.status, 'ready');
  assert.equal(second.changed, false);
  assert.equal(await readFile(join(paths.codexHome, 'config.toml'), 'utf8'), before);
});

test('follows a changed Magpie gateway address and keeps a recovery backup', async t => {
  const paths = await fixture(t, wiredConfig);
  await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  const profilePath = join(paths.codexHome, PROFILE_FILE);
  const first = await readFile(profilePath, 'utf8');

  await writeFile(join(paths.codexHome, 'config.toml'), wiredConfig
    .replace('http://127.0.0.1:3999/v1', 'http://127.0.0.1:4555/v1')
    .replace('http://127.0.0.1:3999/backend-api/codex', 'http://127.0.0.1:4555/backend-api/codex'));
  const checked = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(checked.status, 'would-update');
  assert.match(checked.profile, /http:\/\/127\.0\.0\.1:4555\/v1/);
  const updated = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(updated.status, 'updated');
  assert.equal(await readFile(`${profilePath}.bak`, 'utf8'), first);
  assert.match(await readFile(profilePath, 'utf8'), /4555\/v1/);
});

test('uses gateway.json when the Codex config has no route yet', async t => {
  const paths = await fixture(t, `model = "chatgpt-web/gpt-6"

[model_providers.magpie]
name = "magpie"
wire_api = "responses"
`);
  await writeFile(join(paths.magpieHome, 'gateway.json'), JSON.stringify({ addr: '127.0.0.1:4666' }));
  const result = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(result.status, 'would-create');
  assert.equal(result.baseUrl, 'http://127.0.0.1:4666/v1');
});

test('CLI profile resolves a relative catalogue against the configured home', async t => {
  const paths = await fixture(t, wiredConfig);
  const catalogPath = join(paths.root, 'magpie-desktop-models.json');
  await writeFile(catalogPath, JSON.stringify({ models: [] }));
  const result = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env, home: paths.root });
  assert.equal(result.status, 'would-create');
  assert.ok(result.profile.includes(`model_catalog_json = ${JSON.stringify(catalogPath)}`));
});

test('rollback removes only the managed profile and backup', async t => {
  const paths = await fixture(t, wiredConfig);
  const mainBefore = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
  await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  await writeFile(join(paths.codexHome, 'config.toml'), `${mainBefore}# user edit\n`);
  await writeFile(join(paths.codexHome, `${PROFILE_FILE}.bak`), 'previous managed copy\n');
  const result = await rollbackCodexProfile({ codexHome: paths.codexHome });
  assert.equal(result.status, 'rolled-back');
  await assert.rejects(stat(join(paths.codexHome, PROFILE_FILE)), { code: 'ENOENT' });
  await assert.rejects(stat(join(paths.codexHome, `${PROFILE_FILE}.bak`)), { code: 'ENOENT' });
  assert.equal(await readFile(join(paths.codexHome, 'config.toml'), 'utf8'), `${mainBefore}# user edit\n`);
  assert.equal((await rollbackCodexProfile({ codexHome: paths.codexHome })).status, 'already-absent');
});

test('never overwrites an unmanaged profile', async t => {
  const paths = await fixture(t, wiredConfig);
  const profilePath = join(paths.codexHome, PROFILE_FILE);
  await writeFile(profilePath, 'model_provider = "personal"\n');
  const checked = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(checked.status, 'unmanaged-profile');
  const applied = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(applied.status, 'unmanaged-profile');
  assert.equal(await readFile(profilePath, 'utf8'), 'model_provider = "personal"\n');
  assert.equal((await rollbackCodexProfile({ codexHome: paths.codexHome })).status, 'unmanaged-profile');
});

test('routing parser keeps table-local values separate from top-level values', () => {
  const result = readCodexRouting(wiredConfig);
  assert.equal(result.model, 'chatgpt-web/gpt-6');
  assert.equal(result.openaiBaseUrl, 'http://127.0.0.1:3999/backend-api/codex');
  assert.equal(result.magpieBaseUrl, 'http://127.0.0.1:3999/v1');
  assert.equal(result.magpieEnvKey, 'MAGPIE_API_KEY');
  assert.equal(result.webSockets, undefined);
});

test('Desktop activation journals the exact route and preserves auth and headers', async t => {
  const paths = await fixture(t, wiredConfig);
  const configPath = join(paths.codexHome, 'config.toml');
  const original = await readFile(configPath, 'utf8');
  const checked = await inspectActivatedCodexRoute({ codexHome: paths.codexHome });
  assert.equal(checked.status, 'would-activate');

  const activated = await activateCodexRoute({ codexHome: paths.codexHome });
  assert.equal(activated.status, 'activated');
  const current = await readFile(configPath, 'utf8');
  assert.match(current, /^model_provider = "magpie"$/m);
  assert.match(current, /supports_websockets = false/);
  for (const unchanged of [
    'wire_api = "responses"',
    'experimental_bearer_token = "fixture-bearer-token"',
    'http_headers = { "x-openai-actor-authorization" = "magpie", "x-fixture" = "kept" }',
    'requires_openai_auth = true',
    'capabilities = { remote_compaction = "v2" }',
  ]) assert.ok(current.includes(unchanged), unchanged);
  assert.equal(await readFile(join(paths.codexHome, CONFIG_BACKUP_FILE), 'utf8'), original);
  const journal = JSON.parse(await readFile(join(paths.codexHome, JOURNAL_FILE), 'utf8'));
  assert.equal(journal.previous.modelProvider.present, false);
  assert.equal(journal.previous.webSockets.present, false);
  assert.equal(journal.previous.contextWindow.present, false);
  assert.equal(journal.previous.compactLimit.present, false);
  assert.equal((await activateCodexRoute({ codexHome: paths.codexHome })).changed, false);
});

test('Desktop activation removes global context overrides and rollback restores them', async t => {
  const configured = wiredConfig.replace(
    'model = "chatgpt-web/gpt-6"',
    'model = "chatgpt-web/gpt-6"\nmodel_context_window = 1050000\nmodel_auto_compact_token_limit = 945000',
  );
  const paths = await fixture(t, configured);
  const configPath = join(paths.codexHome, 'config.toml');
  await activateCodexRoute({ codexHome: paths.codexHome });
  const activated = await readFile(configPath, 'utf8');
  assert.doesNotMatch(activated, /^model_context_window =/m);
  assert.doesNotMatch(activated, /^model_auto_compact_token_limit =/m);
  const journal = JSON.parse(await readFile(join(paths.codexHome, JOURNAL_FILE), 'utf8'));
  assert.equal(journal.previous.contextWindow.rawLine, 'model_context_window = 1050000');
  assert.equal(journal.previous.compactLimit.rawLine, 'model_auto_compact_token_limit = 945000');

  assert.equal((await rollbackCodexRoute({ codexHome: paths.codexHome })).status, 'deactivated');
  const restored = await readFile(configPath, 'utf8');
  assert.match(restored, /^model_context_window = 1050000$/m);
  assert.match(restored, /^model_auto_compact_token_limit = 945000$/m);
});

test('Desktop activation makes an existing relative model catalogue absolute for metadata lookup', async t => {
  const paths = await fixture(t, wiredConfig);
  const catalogPath = join(paths.root, 'magpie-desktop-models.json');
  await writeFile(catalogPath, JSON.stringify({ models: [] }));
  await activateCodexRoute({ codexHome: paths.codexHome, home: paths.root });
  const configText = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
  assert.ok(configText.includes(`model_catalog_json = ${JSON.stringify(catalogPath)}`));
  const journal = JSON.parse(await readFile(join(paths.codexHome, JOURNAL_FILE), 'utf8'));
  assert.equal(journal.installed.catalogPath, catalogPath);
  assert.equal(journal.previous.catalog.rawLine, 'model_catalog_json = "magpie-desktop-models.json"');

  assert.equal((await rollbackCodexRoute({ codexHome: paths.codexHome })).status, 'deactivated');
  assert.match(await readFile(join(paths.codexHome, 'config.toml'), 'utf8'), /model_catalog_json = "magpie-desktop-models\.json"/);
});

test('a pending activation journal is repaired to active after an interrupted write', async t => {
  const paths = await fixture(t, wiredConfig);
  await activateCodexRoute({ codexHome: paths.codexHome });
  const journalPath = join(paths.codexHome, JOURNAL_FILE);
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  await writeFile(journalPath, `${JSON.stringify({ ...journal, state: 'pending' }, null, 2)}\n`);
  const repaired = await repairActivatedCodexRoute({ codexHome: paths.codexHome });
  assert.equal(repaired.status, 'repaired');
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).state, 'active');
});

test('a legacy Desktop journal migrates and records context overrides before removing them', async t => {
  const configured = wiredConfig.replace(
    'model = "chatgpt-web/gpt-6"',
    'model = "chatgpt-web/gpt-6"\nmodel_context_window = 1050000\nmodel_auto_compact_token_limit = 945000',
  );
  const legacyActivated = configured
    .replace('model_auto_compact_token_limit = 945000', 'model_auto_compact_token_limit = 945000\nmodel_provider = "magpie"')
    .replace('wire_api = "responses"', 'supports_websockets = false\nwire_api = "responses"');
  const paths = await fixture(t, legacyActivated);
  const configPath = join(paths.codexHome, 'config.toml');
  await writeFile(join(paths.codexHome, CONFIG_BACKUP_FILE), configured);
  await writeFile(join(paths.codexHome, JOURNAL_FILE), `${JSON.stringify({
    version: 1,
    active: true,
    state: 'active',
    configPath,
    backupPath: join(paths.codexHome, CONFIG_BACKUP_FILE),
    previous: { modelProvider: { present: false }, webSockets: { present: false } },
    installed: { modelProvider: 'magpie', supportsWebSockets: false },
  }, null, 2)}\n`);

  const migrated = await activateCodexRoute({ codexHome: paths.codexHome });
  assert.equal(migrated.status, 'repaired');
  const journal = JSON.parse(await readFile(join(paths.codexHome, JOURNAL_FILE), 'utf8'));
  assert.equal(journal.installed.contextOverridesRemoved, true);
  assert.equal(journal.previous.contextWindow.rawLine, 'model_context_window = 1050000');
  assert.equal(journal.previous.compactLimit.rawLine, 'model_auto_compact_token_limit = 945000');
  assert.doesNotMatch(await readFile(configPath, 'utf8'), /^model_context_window =/m);

  assert.equal((await rollbackCodexRoute({ codexHome: paths.codexHome })).status, 'deactivated');
  const restored = await readFile(configPath, 'utf8');
  assert.match(restored, /^model_context_window = 1050000$/m);
  assert.match(restored, /^model_auto_compact_token_limit = 945000$/m);
});

test('automatic repair treats newly re-added context overrides as a conflict', async t => {
  const paths = await fixture(t, wiredConfig);
  const configPath = join(paths.codexHome, 'config.toml');
  await activateCodexRoute({ codexHome: paths.codexHome });
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace(
    'model = "chatgpt-web/gpt-6"',
    'model = "chatgpt-web/gpt-6"\nmodel_context_window = 77777',
  ));
  const repaired = await repairActivatedCodexRoute({ codexHome: paths.codexHome });
  assert.equal(repaired.status, 'conflict');
  assert.match(await readFile(configPath, 'utf8'), /^model_context_window = 77777$/m);
});

test('rollback can recover a pending journal before the config rewrite', async t => {
  const configured = wiredConfig.replace(
    'model = "chatgpt-web/gpt-6"',
    'model = "chatgpt-web/gpt-6"\nmodel_context_window = 1050000\nmodel_auto_compact_token_limit = 945000',
  );
  const paths = await fixture(t, configured);
  const configPath = join(paths.codexHome, 'config.toml');
  await writeFile(join(paths.codexHome, JOURNAL_FILE), `${JSON.stringify({
    version: 1,
    active: true,
    state: 'pending',
    configPath,
    backupPath: join(paths.codexHome, CONFIG_BACKUP_FILE),
    previous: {
      modelProvider: { present: false },
      webSockets: { present: false },
      contextWindow: { present: true, rawLine: 'model_context_window = 1050000' },
      compactLimit: { present: true, rawLine: 'model_auto_compact_token_limit = 945000' },
    },
    installed: { modelProvider: 'magpie', supportsWebSockets: false, contextOverridesRemoved: true },
  }, null, 2)}\n`);
  assert.equal((await rollbackCodexRoute({ codexHome: paths.codexHome })).status, 'deactivated');
  assert.equal(await readFile(configPath, 'utf8'), configured);
});

test('active Desktop route is repaired after Magpie rewrites its table', async t => {
  const paths = await fixture(t, wiredConfig);
  const configPath = join(paths.codexHome, 'config.toml');
  await activateCodexRoute({ codexHome: paths.codexHome });
  const rewritten = wiredConfig.replace('http://127.0.0.1:3999/v1', 'http://127.0.0.1:4777/v1');
  await writeFile(configPath, rewritten);
  const checked = await inspectActivatedCodexRoute({ codexHome: paths.codexHome });
  assert.equal(checked.status, 'would-update');
  const repaired = await repairActivatedCodexRoute({ codexHome: paths.codexHome });
  assert.equal(repaired.status, 'repaired');
  const current = await readFile(configPath, 'utf8');
  assert.match(current, /4777\/v1/);
  assert.match(current, /^model_provider = "magpie"$/m);
  assert.match(current, /supports_websockets = false/);
  assert.match(current, /requires_openai_auth = true/);
});

test('Desktop rollback restores the journalled route and leaves unrelated edits', async t => {
  const paths = await fixture(t, wiredConfig);
  const configPath = join(paths.codexHome, 'config.toml');
  await activateCodexRoute({ codexHome: paths.codexHome });
  await writeFile(configPath, `${await readFile(configPath, 'utf8')}# unrelated user edit\n`);
  const rolledBack = await rollbackCodexRoute({ codexHome: paths.codexHome });
  assert.equal(rolledBack.status, 'deactivated');
  const restored = await readFile(configPath, 'utf8');
  assert.doesNotMatch(restored, /^model_provider =/m);
  assert.doesNotMatch(restored, /supports_websockets/);
  assert.match(restored, /# unrelated user edit/);
  assert.match(restored, /experimental_bearer_token = "fixture-bearer-token"/);
  await assert.rejects(stat(join(paths.codexHome, JOURNAL_FILE)), { code: 'ENOENT' });
  await assert.rejects(stat(join(paths.codexHome, CONFIG_BACKUP_FILE)), { code: 'ENOENT' });
});

test('Desktop activation and rollback fail closed on conflicting user changes', async t => {
  const customProvider = await fixture(t, wiredConfig.replace('model = "chatgpt-web/gpt-6"', 'model = "chatgpt-web/gpt-6"\nmodel_provider = "mine"'));
  const conflict = await activateCodexRoute({ codexHome: customProvider.codexHome });
  assert.equal(conflict.status, 'conflict');
  assert.equal(await readFile(join(customProvider.codexHome, 'config.toml'), 'utf8'), wiredConfig.replace('model = "chatgpt-web/gpt-6"', 'model = "chatgpt-web/gpt-6"\nmodel_provider = "mine"'));

  const trueWebSockets = await fixture(t, wiredConfig.replace('requires_openai_auth = true', 'supports_websockets = true\nrequires_openai_auth = true'));
  const trueConflict = await activateCodexRoute({ codexHome: trueWebSockets.codexHome });
  assert.equal(trueConflict.status, 'conflict');

  const paths = await fixture(t, wiredConfig);
  await activateCodexRoute({ codexHome: paths.codexHome });
  const configPath = join(paths.codexHome, 'config.toml');
  await writeFile(configPath, `${(await readFile(configPath, 'utf8')).replace('model_provider = "magpie"', 'model_provider = "mine"')}`);
  const rollbackConflict = await rollbackCodexRoute({ codexHome: paths.codexHome });
  assert.equal(rollbackConflict.status, 'conflict');
  assert.match(await readFile(configPath, 'utf8'), /model_provider = "mine"/);
});
