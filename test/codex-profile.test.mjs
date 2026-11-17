import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MANAGED_MARKER,
  LEGACY_MANAGED_MARKER,
  PROFILE_FILE,
  NATIVE_PROFILE_NAME,
  NATIVE_PROFILE_FILE,
  applyCodexProfile,
  inspectCodexProfile,
  readCodexRouting,
  rollbackCodexProfile,
  main,
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

async function nativeFixture(t, config = wiredConfig) {
  const paths = await fixture(t, config);
  const catalogPath = join(paths.codexHome, 'magpie-desktop-models.json');
  await writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'chatgpt-web/gpt-6' }] }));
  const authPath = join(paths.codexHome, 'auth.json');
  await writeFile(authPath, '{"fixture":"untouched-auth"}\n');
  // Explicit options isolate tests without changing HOME or CODEX_HOME.
  return { ...paths, native: true, home: paths.root, env: {}, catalogPath, authPath };
}

test('Native resolves relative catalogue beside config and never adopts a stale home copy', async t => {
  const paths = await nativeFixture(t);
  const stale = join(paths.root, 'magpie-desktop-models.json');
  await writeFile(stale, JSON.stringify({ models: [{ slug: 'stale-text-only' }] }));
  const result = await inspectCodexProfile(paths);
  assert.ok(result.profile.includes(`model_catalog_json = ${JSON.stringify(paths.catalogPath)}`));
  await rm(paths.catalogPath);
  assert.equal((await inspectCodexProfile(paths)).status, 'missing-native-catalog');
  // An explicit absolute path still means exactly what the user configured.
  await writeFile(join(paths.codexHome, 'config.toml'), wiredConfig.replace('"magpie-desktop-models.json"', JSON.stringify(stale)));
  assert.ok((await inspectCodexProfile(paths)).profile.includes(`model_catalog_json = ${JSON.stringify(stale)}`));
});

test('Native selects the built-in route and absolute catalogue without custom credentials or generic limits', async t => {
  const paths = await nativeFixture(t);
  const genericBefore = await inspectCodexProfile({ ...paths, native: false });
  const result = await inspectCodexProfile(paths);
  assert.equal(result.status, 'would-create');
  assert.equal(result.profilePath, join(paths.codexHome, NATIVE_PROFILE_FILE));
  assert.equal(result.baseUrl, 'http://127.0.0.1:3999/backend-api/codex');
  assert.match(result.profile, /^model_provider = "openai"$/m);
  assert.match(result.profile, /^openai_base_url = "http:\/\/127\.0\.0\.1:3999\/backend-api\/codex"$/m);
  assert.ok(result.profile.includes(`model_catalog_json = ${JSON.stringify(paths.catalogPath)}`));
  assert.doesNotMatch(result.profile, /model_context_window|model_auto_compact_token_limit|model_providers|env_key|bearer|http_headers|requires_openai_auth|supports_websockets|fixture-bearer-token/);
  assert.equal((await inspectCodexProfile({ ...paths, native: false })).profile, genericBefore.profile);
  await assert.rejects(stat(result.profilePath), { code: 'ENOENT' });
});

test('Native needs no custom provider table and accepts an explicit validated route', async t => {
  const configuredOnly = await nativeFixture(t, wiredConfig.split('[model_providers.magpie]')[0]);
  assert.equal((await inspectCodexProfile(configuredOnly)).status, 'would-create');
  const paths = await nativeFixture(t, 'model_catalog_json = "magpie-desktop-models.json"\n');
  const options = { ...paths, baseUrl: 'https://localhost:4555/backend-api/codex/' };
  const result = await inspectCodexProfile(options);
  assert.equal(result.status, 'would-create');
  assert.equal(result.baseUrl, 'https://localhost:4555/backend-api/codex');
  assert.match(result.profile, /^model_provider = "openai"$/m);
  const configured = await nativeFixture(t);
  const override = await inspectCodexProfile({ ...configured, baseUrl: 'http://[::1]:4666/backend-api/codex' });
  assert.equal(override.baseUrl, 'http://[::1]:4666/backend-api/codex');
});

test('Native check/apply/update/rollback isolate both profiles and preserve config, catalogue and auth bytes', async t => {
  const paths = await nativeFixture(t);
  const generic = await applyCodexProfile({ ...paths, native: false });
  await writeFile(generic.backupPath, 'generic backup sentinel\n');
  const protectedFiles = [join(paths.codexHome, 'config.toml'), paths.catalogPath, paths.authPath, generic.profilePath, generic.backupPath];
  const before = await Promise.all(protectedFiles.map(path => readFile(path)));
  const args = ['--native', '--codex-home', paths.codexHome];
  const check = await main([...args, '--check'], paths.env);
  assert.equal(check.exitCode, 1);
  assert.match(check.output, /--native --apply/);
  await assert.rejects(stat(join(paths.codexHome, NATIVE_PROFILE_FILE)), { code: 'ENOENT' });
  const applied = await main([...args, '--apply'], paths.env);
  assert.equal(applied.exitCode, 0);
  assert.ok(applied.output.includes(`codex -p ${NATIVE_PROFILE_NAME}`));
  const first = await inspectCodexProfile(paths);
  assert.equal(first.status, 'ready');
  assert.equal((await main([...args, '--check', '--json'], paths.env)).exitCode, 0);
  assert.equal((await applyCodexProfile(paths)).status, 'ready');
  const updated = await applyCodexProfile({ ...paths, baseUrl: 'http://localhost:4777/backend-api/codex' });
  assert.equal(updated.status, 'updated');
  assert.equal(await readFile(updated.backupPath, 'utf8'), first.profile);
  assert.equal((await main([...args, '--rollback'], paths.env)).exitCode, 0);
  await assert.rejects(stat(updated.profilePath), { code: 'ENOENT' });
  await assert.rejects(stat(updated.backupPath), { code: 'ENOENT' });
  assert.equal((await rollbackCodexProfile(paths)).status, 'already-absent');
  for (const [index, path] of protectedFiles.entries()) assert.deepEqual(await readFile(path), before[index]);
  // Selecting generic rollback must also leave an existing Native profile alone.
  const native = await applyCodexProfile(paths);
  await writeFile(native.backupPath, 'native backup sentinel\n');
  await rollbackCodexProfile({ ...paths, native: false });
  assert.equal(await readFile(native.profilePath, 'utf8'), native.profile);
  assert.equal(await readFile(native.backupPath, 'utf8'), 'native backup sentinel\n');
});

test('Native refuses unmanaged targets for check, apply and rollback, including JSON exit status', async t => {
  const paths = await nativeFixture(t);
  const target = join(paths.codexHome, NATIVE_PROFILE_FILE);
  await writeFile(target, '# personal profile\n');
  await writeFile(`${target}.bak`, '# personal backup\n');
  for (const action of ['--check', '--apply', '--rollback']) {
    const result = await main(['--native', action, '--json', '--codex-home', paths.codexHome], paths.env);
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.output).status, 'unmanaged-profile');
    assert.equal(await readFile(target, 'utf8'), '# personal profile\n');
    assert.equal(await readFile(`${target}.bak`, 'utf8'), '# personal backup\n');
  }
});

test('Native missing URL does not fall back to a custom provider or gateway address', async t => {
  const paths = await nativeFixture(t, wiredConfig.replace(/^openai_base_url.*\n/m, ''));
  await writeFile(join(paths.magpieHome, 'gateway.json'), JSON.stringify({ addr: '127.0.0.1:4888' }));
  const env = { MAGPIE_ADDR: '127.0.0.1:4999', MAGPIE_CONFIG_DIR: paths.magpieHome };
  const result = await applyCodexProfile({ ...paths, env });
  assert.equal(result.status, 'missing-native-base-url');
  assert.match(result.detail, /openai_base_url or --base-url/);
  for (const json of [[], ['--json']]) {
    const cli = await main(['--native', '--apply', '--codex-home', paths.codexHome, ...json], env);
    assert.equal(cli.exitCode, 2);
    assert.match(cli.output, /missing-native-base-url/);
    assert.doesNotMatch(cli.output, /fixture-bearer-token|MAGPIE_API_KEY/);
  }
  await assert.rejects(stat(result.profilePath), { code: 'ENOENT' });
});

test('Native rejects invalid explicit and configured URLs without leaking them or falling back', async t => {
  const paths = await nativeFixture(t);
  const invalid = ['', 'not-a-url', 'file:///backend-api/codex', 'http://localhost:3999/v1',
    'https://user:synthetic-secret@localhost/backend-api/codex',
    'http://localhost/backend-api/codex?token=synthetic-secret',
    'http://localhost/backend-api/codex#synthetic-secret'];
  for (const baseUrl of invalid) {
    const checked = await applyCodexProfile({ ...paths, baseUrl });
    assert.equal(checked.status, 'invalid-native-base-url');
    const cli = await main(['--native', '--apply', '--json', '--base-url', baseUrl, '--codex-home', paths.codexHome], paths.env);
    assert.equal(cli.exitCode, 2);
    assert.doesNotMatch(cli.output, /synthetic-secret|fixture-bearer-token/);
    await assert.rejects(stat(checked.profilePath), { code: 'ENOENT' });
  }
  await writeFile(join(paths.codexHome, 'config.toml'), wiredConfig.replace('3999/backend-api/codex', '3999/v1'));
  assert.equal((await inspectCodexProfile(paths)).status, 'invalid-native-base-url');
});

test('Native requires a readable non-empty catalogue, resolving under the configured home', async t => {
  const paths = await nativeFixture(t);
  await rm(paths.catalogPath);
  for (const content of [undefined, 'invalid JSON', 'null', '{}', '{"models":[]}', '{"models":{}}']) {
    if (content !== undefined) await writeFile(paths.catalogPath, content);
    const result = await applyCodexProfile(paths);
    assert.equal(result.status, 'missing-native-catalog');
    assert.match(result.detail, /model_catalog_json/);
    const cli = await main(['--native', '--apply', '--json', '--codex-home', paths.codexHome], paths.env);
    assert.equal(cli.exitCode, 2);
    assert.equal(JSON.parse(cli.output).status, 'missing-native-catalog');
    await assert.rejects(stat(result.profilePath), { code: 'ENOENT' });
  }
  await rm(paths.catalogPath);
  const local = join(paths.codexHome, 'magpie-desktop-models.json');
  await writeFile(local, '{"models":[{"slug":"chatgpt-web/gpt-6"}]}');
  assert.ok((await inspectCodexProfile(paths)).profile.includes(`model_catalog_json = ${JSON.stringify(local)}`));
  await writeFile(join(paths.codexHome, 'config.toml'), wiredConfig.replace('"magpie-desktop-models.json"', JSON.stringify(local)));
  assert.equal((await inspectCodexProfile(paths)).status, 'would-create');
});

test('Native missing config fails actionably and rollback works even after its inputs disappear', async t => {
  const paths = await nativeFixture(t);
  const applied = await applyCodexProfile(paths);
  await rm(join(paths.codexHome, 'config.toml'));
  await rm(paths.catalogPath);
  for (const action of ['--check', '--apply']) {
    const cli = await main(['--native', action, '--json', '--codex-home', paths.codexHome], paths.env);
    assert.equal(cli.exitCode, 2);
    assert.equal(JSON.parse(cli.output).status, 'missing-config');
  }
  assert.equal((await main(['--native', '--rollback', '--codex-home', paths.codexHome], paths.env)).exitCode, 0);
  await assert.rejects(stat(applied.profilePath), { code: 'ENOENT' });
  assert.equal(await readFile(paths.authPath, 'utf8'), '{"fixture":"untouched-auth"}\n');
});

test('CLI help explains the separate Native profile and retains action exclusivity', async () => {
  const result = await main(['--help'], {});
  assert.ok(result.output.includes(NATIVE_PROFILE_FILE));
  assert.ok(result.output.includes(`codex -p ${NATIVE_PROFILE_NAME}`));
  await assert.rejects(main(['--native', '--apply', '--rollback'], {}), /choose one/);
});

test('opt-in Native skill budget changes only discovery allocation and can restore inheritance', async t => {
  const paths = await nativeFixture(t, `${wiredConfig}\n[skills]\nmax_context_tokens = 1200\n`);
  const basePath = join(paths.codexHome, 'config.toml');
  const base = await readFile(basePath, 'utf8');
  const auth = await readFile(paths.authPath, 'utf8');
  const generic = await applyCodexProfile({ ...paths, native: false });
  const genericBefore = await readFile(generic.profilePath, 'utf8');
  const baseline = await inspectCodexProfile(paths);
  assert.doesNotMatch(baseline.profile, /max_context_tokens/);
  const options = { ...paths, skillsContextTokens: 5000 };
  const inspected = await inspectCodexProfile(options);
  const skillSection = '# Skill discovery uses this part of the existing model window; it does not add capacity.\n[skills]\nmax_context_tokens = 5000\n';
  assert.equal(inspected.profile, baseline.profile + '\n' + skillSection);
  assert.doesNotMatch(inspected.profile, /model_context_window|model_auto_compact_token_limit/);
  await assert.rejects(stat(inspected.profilePath), { code: 'ENOENT' });
  assert.equal((await applyCodexProfile(options)).status, 'created');
  assert.equal((await applyCodexProfile(options)).status, 'ready');
  assert.equal((await inspectCodexProfile(paths)).status, 'would-update');
  await applyCodexProfile(paths);
  assert.equal(await readFile(inspected.profilePath, 'utf8'), baseline.profile);
  assert.equal(await readFile(basePath, 'utf8'), base);
  assert.equal(await readFile(paths.authPath, 'utf8'), auth);
  assert.equal(await readFile(generic.profilePath, 'utf8'), genericBefore);
});

test('skill budget CLI preserves selected amount in check instructions and rejects invalid modes/values', async t => {
  const paths = await nativeFixture(t);
  const common = ['--native', '--codex-home', paths.codexHome];
  const check = await main([...common, '--check', '--skills-context-tokens', '5000'], paths.env);
  assert.equal(check.exitCode, 1);
  assert.match(check.output, /--native --skills-context-tokens 5000 --apply/);
  for (const amount of ['1', '5000', '10000']) {
    assert.equal((await main([...common, '--apply', '--skills-context-tokens', amount], paths.env)).exitCode, 0);
    assert.equal((await main([...common, '--check', '--skills-context-tokens', amount], paths.env)).exitCode, 0);
  }
  const before = await readFile(join(paths.codexHome, NATIVE_PROFILE_FILE), 'utf8');
  for (const value of ['0', '-1', '10001', '1.5', '1e3', 'NaN', ' 5000', '5000\n[other]', '999999999999999999']) {
    await assert.rejects(main([...common, '--apply', `--skills-context-tokens=${value}`], paths.env), /whole number/);
  }
  await assert.rejects(main(['--skills-context-tokens', '5000'], paths.env), /requires --native/);
  await assert.rejects(main([...common, '--rollback', '--skills-context-tokens', '5000'], paths.env), /check\/apply/);
  assert.equal(await readFile(join(paths.codexHome, NATIVE_PROFILE_FILE), 'utf8'), before);
});

test('programmatic skill budget rejects out-of-range input and cannot take over an unmanaged profile', async t => {
  const paths = await nativeFixture(t);
  for (const value of [0, -1, 10001, 2.5, NaN, Infinity, '5000']) {
    await assert.rejects(applyCodexProfile({ ...paths, skillsContextTokens: value }), /integer from 1 to 10000/);
  }
  await assert.rejects(applyCodexProfile({ ...paths, native: false, skillsContextTokens: 5000 }), /require --native/);
  const profilePath = join(paths.codexHome, NATIVE_PROFILE_FILE);
  await writeFile(profilePath, '# User owned\n[skills]\nmax_context_tokens = 4000\n');
  assert.equal((await applyCodexProfile({ ...paths, skillsContextTokens: 5000 })).status, 'unmanaged-profile');
  assert.equal(await readFile(profilePath, 'utf8'), '# User owned\n[skills]\nmax_context_tokens = 4000\n');
});
