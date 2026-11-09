import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../client/model.mjs';
import { DEFAULT_CONFIG, DEFAULT_PROJECT, validateDraft } from '../client/fields.mjs';
import { parseConfig } from '../dist/projects/config.js';
import { createCatalog, catalogGroups, modelKey } from '../client/catalog.mjs';

const project = { ...DEFAULT_PROJECT, max_concurrency: 1, agent_preset: 'standard', name: 'News', workspace_path: 'F:/business/news', provider: 'deepseek', model: 'deepseek-chat', callback_url: 'https://example.com/results', request_token: 'NEWS_TOKEN' };
test('new installations expose only project and API settings with an empty project list', () => {
  assert.deepEqual(parseConfig({}).projects, {});
  assert.deepEqual(Object.keys(parseConfig({})).sort(), ['api_prefix', 'projects']);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), ['api_prefix', 'projects']);
});

function formFixture() {
  let snapshot = { status: 'ready', writable: true, revision: 7, value: structuredClone(DEFAULT_CONFIG) };
  const listeners = new Set(); const writes = [];
  const form = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    change(patch) { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); },
    async mutate(ops, revision) {
      assert.equal(revision, snapshot.revision); writes.push(ops);
      const value = structuredClone(snapshot.value);
      for (const op of ops) {
        let target = value;
        for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
        if (op.op === 'set') target[op.path.at(-1)] = op.value; else delete target[op.path.at(-1)];
      }
      form.change({ value, revision: revision + 1 }); return true;
    },
  };
  return { form, writes };
}
function addValid(editor, id = 'news') {
  const key = editor.add(); editor.project(key, 'id', id);
  for (const [name, value] of Object.entries(project)) editor.project(key, name, value);
  return key;
}

test('blank and zero concurrency save as unlimited; positive limits survive reopening', async () => {
  const { max_concurrency, ...withoutLimit } = project;
  const omitted = { projects: { news: { ...withoutLimit, callback_headers: {} } } };
  assert.equal(parseConfig(omitted).projects.news.max_concurrency, 0);
  const { form } = formFixture(); const editor = createEditor(form);
  const empty = editor.add();
  assert.equal(editor.getSnapshot().draft.rows[0].max_concurrency, '');
  editor.remove(empty); addValid(editor);
  for (const [value, expected] of [['', 0], [0, 0], ['0', 0], [3, 3]]) {
    editor.project(editor.getSnapshot().draft.rows[0].key, 'max_concurrency', value);
    assert.equal(await editor.save(), true);
    assert.equal(form.getSnapshot().value.projects.news.max_concurrency, expected);
    assert.equal(parseConfig(form.getSnapshot().value).projects.news.max_concurrency, expected);
    const reopened = createEditor(form);
    assert.equal(reopened.getSnapshot().draft.rows[0].max_concurrency, expected); reopened.dispose();
  }
  editor.dispose();
});

test('negative or fractional concurrency is rejected; other numeric settings still require values', () => {
  const draft = value => ({ ...DEFAULT_CONFIG, rows: [{ ...project, id: 'news', key: 'a', max_concurrency: value }] });
  for (const value of [-1, 1.5, 'abc']) {
    assert.ok(validateDraft(draft(value)).errors['a.max_concurrency']);
    const config = { projects: { news: { ...project, callback_headers: {}, max_concurrency: value } } };
    assert.throws(() => parseConfig(config));
  }
  const invalid = draft(''); invalid.rows[0].execution_timeout_seconds = '';
  assert.ok(validateDraft(invalid).errors['a.execution_timeout_seconds']);
});

test('permission mode defaults to workspace-write and survives save and reload for all native modes', async () => {
  const { permission_mode, ...withoutMode } = project;
  assert.equal(parseConfig({ projects: { news: { ...withoutMode, callback_headers: {} } } }).projects.news.permission_mode, 'workspace-write');
  const { form } = formFixture(); const editor = createEditor(form);
  let key = addValid(editor);
  assert.equal(editor.getSnapshot().draft.rows[0].permission_mode, 'workspace-write');
  for (const mode of ['read-only', 'workspace-write', 'auto', 'danger-full-access']) {
    key = editor.getSnapshot().draft.rows[0].key;
    editor.project(key, 'permission_mode', mode);
    assert.equal(await editor.save(), true);
    assert.equal(editor.getSnapshot().draft.rows[0].permission_mode, mode);
    assert.equal(parseConfig(form.getSnapshot().value).projects.news.permission_mode, mode);
  }
  key = editor.getSnapshot().draft.rows[0].key;
  editor.project(key, 'permission_mode', 'invalid');
  assert.equal(await editor.save(), false);
  assert.ok(editor.getSnapshot().errors[key + '.permission_mode']);
  assert.throws(() => parseConfig({ projects: { news: { ...withoutMode, callback_headers: {}, permission_mode: 'invalid' } } }));
  editor.dispose();
});

test('Agent preset preselects and saves a concrete host default without following later changes', async () => {
  const { form } = formFixture(); const editor = createEditor(form);
  let key = addValid(editor);
  editor.project(key, 'agent_preset', '');
  editor.setDefaultPreset('host-default'); // Catalog may arrive after the new row is created.
  assert.equal(editor.getSnapshot().draft.rows[0].agent_preset, 'host-default');
  editor.setDefaultPreset('next-default');
  assert.equal(editor.getSnapshot().draft.rows[0].agent_preset, 'host-default');
  assert.equal(await editor.save(), true);
  assert.equal(parseConfig(form.getSnapshot().value).projects.news.agent_preset, 'host-default');
  const added = editor.add();
  assert.equal(editor.getSnapshot().draft.rows.find(row => row.key === added).agent_preset, 'next-default');
  editor.discard();
  assert.equal(editor.getSnapshot().draft.rows[0].agent_preset, 'host-default');
  key = editor.getSnapshot().draft.rows[0].key;
  editor.project(key, 'agent_preset', 'custom-agent');
  assert.equal(await editor.save(), true);
  assert.equal(editor.getSnapshot().draft.rows[0].agent_preset, 'custom-agent');
  key = editor.getSnapshot().draft.rows[0].key;
  editor.project(key, 'agent_preset', '');
  assert.equal(await editor.save(), false);
  assert.ok(editor.getSnapshot().errors[key + '.agent_preset']);
  assert.equal(parseConfig(form.getSnapshot().value).projects.news.agent_preset, 'custom-agent');
  editor.dispose();
});

test('editor validates input, saves an atomic revision-fenced configuration and restores it', async () => {
  const { form, writes } = formFixture(); const editor = createEditor(form);
  const key = editor.add(); assert.equal(await editor.save(), false); assert.equal(writes.length, 0);
  assert.ok(editor.getSnapshot().errors[key + '.id']); editor.remove(key);
  addValid(editor); assert.equal(await editor.save(), true);
  const stored = form.getSnapshot().value; parseConfig(stored);
  assert.equal(stored.projects.news.max_execution_retries, 3);
  assert.equal('callback_retry_interval_seconds' in stored.projects.news, false);
  assert.equal(editor.getSnapshot().saved, true);
  // Native settings publishes an additional describe refresh after the write.
  form.change({}); assert.equal(editor.getSnapshot().saved, true);
  assert.equal(editor.getSnapshot().message, ''); editor.dispose();
  const reopened = createEditor(form); assert.equal(reopened.getSnapshot().draft.rows[0].id, 'news'); reopened.dispose();
});
test('concurrent changes never overwrite drafts or another editor; discard reloads latest', async () => {
  const { form, writes } = formFixture(); const editor = createEditor(form); addValid(editor);
  form.change({ revision: 8, value: { ...DEFAULT_CONFIG, api_prefix: '/changed/api' } });
  assert.equal(editor.getSnapshot().conflict, true); assert.equal(editor.getSnapshot().draft.rows.length, 1);
  assert.equal(await editor.save(), false); assert.equal(writes.length, 0);
  editor.discard(); assert.equal(editor.getSnapshot().draft.api_prefix, '/changed/api'); editor.dispose();
});

test('saved workspace fields are locked while other fields and project removal remain editable', async () => {
  const { form } = formFixture(); const editor = createEditor(form); addValid(editor);
  assert.equal(await editor.save(), true);
  const row = editor.getSnapshot().draft.rows[0];
  editor.project(row.key, 'workspace_path', 'F:/different'); editor.project(row.key, 'id', 'different');
  assert.equal(editor.getSnapshot().dirty, false);
  assert.equal(editor.getSnapshot().draft.rows[0].workspace_path, project.workspace_path);
  editor.project(row.key, 'max_concurrency', 4);
  assert.equal(await editor.save(), true);
  assert.equal(form.getSnapshot().value.projects.news.request_token, project.request_token);
  assert.equal(form.getSnapshot().value.projects.news.max_concurrency, 4);
  editor.remove(editor.getSnapshot().draft.rows[0].key);
  assert.equal(await editor.save(), true);
  assert.deepEqual(form.getSnapshot().value.projects, {}); editor.dispose();
});
test('failed writes keep drafts and release saving state; read-only refuses writes', async () => {
  const { form } = formFixture(); const editor = createEditor(form); addValid(editor);
  form.mutate = async () => { throw new Error('network unavailable'); };
  assert.equal(await editor.save(), false); assert.equal(editor.getSnapshot().dirty, true); assert.equal(editor.getSnapshot().saving, false);
  form.change({ writable: false }); assert.equal(await editor.save(), false); editor.dispose();
});
test('draft validation rejects duplicate identities, URLs, numeric bounds', () => {
  const rows = [{ ...project, id: 'news', key: 'a' }, { ...project, id: 'news', key: 'b' }];
  const { errors } = validateDraft({ ...DEFAULT_CONFIG, rows });
  assert.ok(errors['b.id']); assert.ok(errors['b.workspace_path']);
  rows[0].callback_url = 'https://user:password@example.com/'; rows[0].max_execution_retries = 1.5;
  const invalid = validateDraft({ ...DEFAULT_CONFIG, rows });
  assert.ok(invalid.errors['a.callback_url']); assert.ok(invalid.errors['a.max_execution_retries']);
});
test('catalog selection keeps same-name models from different providers distinct and saves their pair', async () => {
  const groups = catalogGroups({ groups: [
    { id: 'provider-a', name: 'A', models: [{ id: 'shared-id', name: 'Shared model' }] },
    { id: 'provider-b', name: 'B', models: [{ id: 'shared-id', name: 'Shared model' }] },
  ] });
  assert.notEqual(groups[0].models[0].key, groups[1].models[0].key);
  const { form } = formFixture(); const editor = createEditor(form); const key = addValid(editor);
  const selected = groups[1].models[0]; editor.selectModel(key, selected.provider, selected.model);
  assert.equal(await editor.save(), true);
  assert.equal(form.getSnapshot().value.projects.news.provider, 'provider-b');
  assert.equal(form.getSnapshot().value.projects.news.model, 'shared-id'); editor.dispose();
});
test('catalog shares in-flight reads and rejects stale responses after a refresh', async () => {
  const pending = []; const catalog = createCatalog(() => new Promise(resolve => pending.push(resolve)));
  const first = catalog.load(); assert.equal(catalog.load(), first); await Promise.resolve();
  const second = catalog.refresh(true); await Promise.resolve();
  const reply = id => ({ ok: true, value: { groups: [{ id, name: id, models: [{ id: 'model', name: id }] }], failures: [] } });
  pending[1](reply('new')); await second; pending[0](reply('old')); await first;
  assert.equal(catalog.getSnapshot().groups[0].id, 'new');
  assert.equal(catalog.getSnapshot().groups[0].models[0].key, modelKey('new', 'model')); catalog.dispose();
});
test('catalog preserves loaded choices on errors and exposes partial failures without clearing selection', async () => {
  let fail = false;
  const catalog = createCatalog(async () => fail ? { ok: false, error: {} } : { ok: true, value: {
    groups: [{ id: 'a', name: 'A', models: [{ id: 'm', name: 'Model' }] }], failures: [{ id: 'b', name: 'B', message: 'offline' }],
  } });
  await catalog.load(); assert.equal(catalog.getSnapshot().failures.length, 1);
  fail = true; await catalog.refresh(); assert.equal(catalog.getSnapshot().status, 'error'); assert.equal(catalog.getSnapshot().groups.length, 1);
  await catalog.refresh(true); assert.deepEqual(catalog.getSnapshot().groups, []); catalog.dispose();
});
test('projects sort newest first regardless of numeric IDs and keep undated projects stable', () => {
  const { form } = formFixture();
  const entry = created_at => ({ ...project, callback_headers: {}, ...(created_at ? { created_at } : {}) });
  form.change({ value: { ...DEFAULT_CONFIG, projects: {
    '1': entry('2020-01-01T00:00:00.000Z'),
    '111': entry('2022-01-01T00:00:00.000Z'),
    test: entry('2021-01-01T00:00:00.000Z'),
    legacyA: entry(), legacyB: entry(),
  } } });
  const editor = createEditor(form);
  assert.deepEqual(editor.getSnapshot().draft.rows.map(row => row.id), ['111', 'test', '1', 'legacyA', 'legacyB']);
  editor.dispose();
});

test('new project creation time survives saving, editing and reopening', async () => {
  const { form, writes } = formFixture();
  form.change({ value: { ...DEFAULT_CONFIG, projects: {
    '1': { ...project, callback_headers: {}, created_at: '2020-01-01T00:00:00.000Z' },
  } } });
  const editor = createEditor(form);
  const before = Date.now();
  const key = addValid(editor, '2');
  editor.project(key, 'workspace_path', '');
  const created = editor.getSnapshot().draft.rows[0];
  assert.equal(created.id, '2');
  assert.ok(Date.parse(created.created_at) >= before && Date.parse(created.created_at) <= Date.now());
  assert.equal(await editor.save(), true);
  const saved = form.getSnapshot().value;
  assert.equal(parseConfig(saved).projects['2'].created_at, created.created_at);
  assert.deepEqual(editor.getSnapshot().draft.rows.map(row => row.id), ['2', '1']);
  const older = editor.getSnapshot().draft.rows.find(row => row.id === '1');
  editor.project(older.key, 'name', 'Renamed');
  assert.equal(await editor.save(), true);
  assert.ok(writes.at(-1).every(op => op.path.at(-1) !== 'created_at'));
  assert.equal(form.getSnapshot().value.projects['1'].created_at, '2020-01-01T00:00:00.000Z');
  editor.dispose();
  const reopened = createEditor(form);
  assert.deepEqual(reopened.getSnapshot().draft.rows.map(row => row.id), ['2', '1']);
  assert.equal(reopened.getSnapshot().draft.rows[0].created_at, created.created_at);
  reopened.dispose();
});
