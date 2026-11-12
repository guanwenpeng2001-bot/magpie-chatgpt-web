import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MANAGED_MARKER,
  LEGACY_MANAGED_MARKER,
  PROFILE_FILE,
  applyCodexProfile,
  inspectCodexProfile,
  readCodexRouting,
  rollbackCodexProfile,
} from '../src/codex-profile.mjs';

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

async function fixture(t, config = wiredConfig) {
  const root = await mkdtemp(join(tmpdir(), 'codex-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex');
  const magpieHome = join(root, 'magpie');
  await mkdir(codexHome, { recursive: true });
  await mkdir(magpieHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), config);
  return { root, codexHome, magpieHome, env: { HOME: root, MAGPIE_CONFIG_DIR: magpieHome } };
}

test('derives a provider-wide HTTP CLI profile without modifying the Magpie Desktop config', async t => {
  const paths = await fixture(t);
  const mainPath = join(paths.codexHome, 'config.toml');
  const before = await readFile(mainPath, 'utf8');
  const result = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(result.status, 'would-create');
  assert.equal(result.baseUrl, 'http://127.0.0.1:3999/v1');
  assert.equal(result.profile.includes(MANAGED_MARKER), true);
  assert.match(result.profile, /model_provider = "magpie"/);
  assert.match(result.profile, /^model_context_window = 41000$/m);
  assert.match(result.profile, /^model_auto_compact_token_limit = 32768$/m);
  assert.match(result.profile, /supports_websockets = false/);
  assert.match(result.profile, /env_key = "MAGPIE_API_KEY"/);
  assert.match(result.profile, /experimental_bearer_token = "fixture-bearer-token"/);
  assert.match(result.profile, /x-fixture" = "kept"/);
  assert.match(result.profile, /requires_openai_auth = true/);
  assert.match(result.profile, /capabilities = \{ remote_compaction = "v2" \}/);
  assert.match(result.profile, /model_catalog_json = "magpie-desktop-models.json"/);
  assert.doesNotMatch(result.profile, /^model =/m);
  assert.equal(await readFile(mainPath, 'utf8'), before);
});

test('check mode never writes and apply is idempotent', async t => {
  const paths = await fixture(t);
  const before = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
  const checked = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(checked.status, 'would-create');
  await assert.rejects(stat(join(paths.codexHome, PROFILE_FILE)), { code: 'ENOENT' });

  const first = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(first.status, 'created');
  const written = await readFile(join(paths.codexHome, PROFILE_FILE), 'utf8');
  assert.equal(written, checked.profile);
  assert.equal(await readFile(join(paths.codexHome, 'config.toml'), 'utf8'), before);

  const second = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(second.status, 'ready');
  assert.equal(second.changed, false);
});

test('an old 0.4.4 managed CLI profile migrates instead of becoming unmanaged', async t => {
  const paths = await fixture(t);
  const profilePath = join(paths.codexHome, PROFILE_FILE);
  await writeFile(profilePath, `${LEGACY_MANAGED_MARKER}\nmodel_provider = "magpie"\n`);
  const checked = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(checked.status, 'would-update');
  const updated = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(updated.status, 'updated');
  assert.match(await readFile(profilePath, 'utf8'), /^# Managed by magpie-chatgpt-web; `--rollback` removes only this CLI profile\./);
});

test('CLI profile follows a changed Magpie gateway address and keeps a recovery backup', async t => {
  const paths = await fixture(t);
  await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  const profilePath = join(paths.codexHome, PROFILE_FILE);
  const first = await readFile(profilePath, 'utf8');
  await writeFile(join(paths.codexHome, 'config.toml'), wiredConfig
    .replace('http://127.0.0.1:3999/v1', 'http://127.0.0.1:4555/v1')
    .replace('http://127.0.0.1:3999/backend-api/codex', 'http://127.0.0.1:4555/backend-api/codex'));
  const checked = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(checked.status, 'would-update');
  const updated = await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  assert.equal(updated.status, 'updated');
  assert.equal(await readFile(`${profilePath}.bak`, 'utf8'), first);
  assert.match(await readFile(profilePath, 'utf8'), /4555\/v1/);
});

test('CLI profile resolves an existing relative catalogue to its actual absolute path', async t => {
  const paths = await fixture(t);
  const catalogPath = join(paths.root, 'magpie-desktop-models.json');
  await writeFile(catalogPath, JSON.stringify({ models: [] }));
  const result = await inspectCodexProfile({ codexHome: paths.codexHome, env: paths.env, home: paths.root });
  assert.equal(result.status, 'would-create');
  assert.ok(result.profile.includes(`model_catalog_json = ${JSON.stringify(catalogPath)}`));
});

test('uses gateway.json when the Codex config has no base URL', async t => {
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

test('rollback removes only the managed CLI profile and leaves the main config untouched', async t => {
  const paths = await fixture(t);
  const mainPath = join(paths.codexHome, 'config.toml');
  await applyCodexProfile({ codexHome: paths.codexHome, env: paths.env });
  const before = await readFile(mainPath, 'utf8');
  await writeFile(`${join(paths.codexHome, PROFILE_FILE)}.bak`, 'previous managed copy\n');
  const result = await rollbackCodexProfile({ codexHome: paths.codexHome });
  assert.equal(result.status, 'rolled-back');
  await assert.rejects(stat(join(paths.codexHome, PROFILE_FILE)), { code: 'ENOENT' });
  await assert.rejects(stat(`${join(paths.codexHome, PROFILE_FILE)}.bak`), { code: 'ENOENT' });
  assert.equal(await readFile(mainPath, 'utf8'), before);
  assert.equal((await rollbackCodexProfile({ codexHome: paths.codexHome })).status, 'already-absent');
});

test('never overwrites an unmanaged CLI profile', async t => {
  const paths = await fixture(t);
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
  assert.equal(result.modelProvider, undefined);
  assert.equal(result.modelCatalog, 'magpie-desktop-models.json');
  assert.equal(result.openaiBaseUrl, 'http://127.0.0.1:3999/backend-api/codex');
  assert.equal(result.magpieBaseUrl, 'http://127.0.0.1:3999/v1');
  assert.equal(result.magpieEnvKey, 'MAGPIE_API_KEY');
  assert.equal(result.webSockets, undefined);
});
