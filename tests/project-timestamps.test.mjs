import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { until } from './helpers.mjs';

test('startup fills missing project times through DSH and persists them across reloads without touching workspaces', {
  skip: !process.env.DSH_TEST_PACKAGE,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { boot, readProfilePatches } = await load('dsh-app-boot');
  const { Service } = await load('cordis');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-project-times-'));
  const home = join(dir, 'home'); await mkdir(home);
  let ctx;
  t.after(async () => {
    await ctx?.fiber.dispose();
    const child = relative(tmpdir(), dir); assert(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'project-times-test', dsh: { profile: { bundles: [] } } }));
  await writeFile(join(dir, 'cordis.yml'), '[]');
  await writeFile(join(dir, 'bridge.mjs'), [
    'export { Config } from ' + JSON.stringify(new URL('../dist/dsh/settings.js', import.meta.url).href) + ';',
    'import { initializeProjectTimestamps } from ' + JSON.stringify(new URL('../dist/dsh/settings.js', import.meta.url).href) + ';',
    'export function apply(ctx, config) { initializeProjectTimestamps(ctx, config); }',
  ].join(String.fromCharCode(10)));
  const workspace = join(dir, 'must-not-be-created');
  const project = { provider: 'test', model: 'test', callback_url: 'http://localhost/callback', workspace_path: workspace, request_token: 'preserve-token' };
  const originalTime = '2020-01-01T00:00:00.000Z';
  const patches = [{ insert: [
    { id: 'custom-bridge-id', name: pathToFileURL(join(dir, 'bridge.mjs')).href, config: { projects: {
      '1': { ...project }, '111': { ...project }, test: { ...project, created_at: originalTime },
    } } },
    ...['dsh-config-editor', 'dsh-settings'].map(name => ({ id: name, name: pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)).href })),
  ] }];
  const profile = { dir, home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: dir, cwd: dir, startedBundles: [], overlays: [], name: 'test' };
  await writeFile(profile.patchPath, JSON.stringify(patches));
  const start = () => boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), async c => {
    class Profile extends Service { constructor(c) { super(c, 'profileContext'); Object.assign(this, profile); } }
    await c.plugin(Profile).await();
  });
  const before = Date.now();
  ctx = await start();
  const projects = () => ctx.settings.describe().find(row => row.ns === 'custom-bridge-id')?.value.projects;
  await until(() => projects()?.['1'].created_at);
  const filled = projects();
  assert.ok(Date.parse(filled['1'].created_at) >= before && Date.parse(filled['1'].created_at) <= Date.now());
  assert.equal(filled['111'].created_at, filled['1'].created_at);
  assert.equal(filled.test.created_at, originalTime);
  assert.equal(filled['1'].request_token, 'preserve-token');
  assert.equal(filled['1'].workspace_path, workspace);
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  const saved = await readFile(profile.patchPath, 'utf8');
  assert.ok(saved.includes(filled['1'].created_at));
  await ctx.fiber.dispose(); ctx = await start();
  assert.equal(projects()['1'].created_at, filled['1'].created_at);
  assert.equal(projects().test.created_at, originalTime);
  await ctx.fiber.dispose(); ctx = undefined;
  assert.equal(await readFile(profile.patchPath, 'utf8'), saved);
});
