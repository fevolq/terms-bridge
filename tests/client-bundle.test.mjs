import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Exercise the shipped bundle and rendered controls with small host/React doubles.
// State and effects are explicit so no browser dependencies enter the plugin package.
async function fixture(paths = { news: 'F:/work/news' }) {
  let snapshot = { status: 'ready', writable: true, revision: 1, value: { api_prefix: '/api/terms-bridge', projects: {} } };
  const listeners = new Set(), cleanup = [], effects = [], hooks = [], styles = [];
  let hook = 0, Component, extension, registration;
  const change = patch => { snapshot = { ...snapshot, ...patch }; for (const fn of listeners) fn(); };
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== false && value !== null && value !== undefined) }),
    useSyncExternalStore: (_subscribe, read) => read(),
    useState(initial) { const index = hook++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value; }]; },
    useEffect(fn, dependencies) {
      const index = hook++, old = hooks[index]; hooks[index] = dependencies;
      if (!old || dependencies.some((value, i) => old[i] !== value)) effects.push(fn);
    },
  };
  const ctx = {
    inject: (_services, apply) => ({ await: async () => apply(ctx) }),
    effect: fn => { const dispose = fn(); if (dispose) cleanup.push(dispose); }, on() {},
    configForms: {
      get: () => ({ getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }),
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'terms-bridge', secrets: [] }] } }), acceptView: change }),
    },
    // Other dsh workspaces may have the same directory name; the page must not search this list.
    workspaces: { list: { subscribe() {}, getSnapshot: () => { throw new Error('Workspace guessing is forbidden'); } } },
    remote: { $on() {}, $mount: async contribution => {
      assert.equal(contribution.descriptors[0].namespace, 'termsBridge'); return () => {};
    },
      termsBridge: { workspaces: async () => ({ ok: true, value: paths }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: '聊天模型' }] }], failures: [] } }) },
      agentPresets: { list: async () => ({ ok: true, value: { presets: [{ id: 'standard' }, { id: 'no-subagent', name: 'NoSubAgent', isDefault: true }] } }) },
      settings: { async mutate(namespace, ops, revision) {
        assert.equal(namespace, 'terms-bridge'); assert.equal(revision, snapshot.revision);
        const value = structuredClone(snapshot.value);
        for (const op of ops) {
          let target = value;
          for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
          if (op.op === 'set') target[op.path.at(-1)] = op.value; else delete target[op.path.at(-1)];
        }
        return { ok: true, value: { ...snapshot, revision: revision + 1, value } };
      } },
    },
    slots: { inject: (_name, fn) => fn(), register(info, component) { registration = info; Component = component; } },
  };
  runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    structuredClone, TextEncoder, URL,
    window: { __ModuleLoader__: { load(value) { extension = value; } } },
    document: { createElement() { return { remove() { styles.pop(); } }; }, head: { append: value => styles.push(value) }, body: {}, querySelectorAll: () => [], getElementById: () => null },
    MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: fn => fn(),
  });
  assert.equal(extension.id, '@fevolq/terms-bridge');
  await extension.factory(name => { assert.equal(name, 'react'); return React; }).apply(ctx);
  assert.equal(registration.label(), '项目接入'); assert.equal(styles.length, 1);
  const render = () => { hook = 0; const tree = Component(); effects.splice(0).forEach(fn => fn()); return tree; };
  const flush = async () => { render(); await nextTurn(); render(); await nextTurn(); return render(); };
  return { render, flush, change, snapshot: () => snapshot, close() { cleanup.reverse().forEach(fn => fn()); assert.equal(styles.length, 0); assert.equal(listeners.size, 0); } };
}
function nodes(tree) { return typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []; }
function text(tree) { return typeof tree === 'object' ? tree.children.map(text).join('') : String(tree); }
function control(tree, name) { const node = nodes(tree).find(node => node.props.id?.endsWith('.' + name)); assert.ok(node, name); return node; }
function click(tree, label) { const node = nodes(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(node, label); return node.props.onClick(); }

test('shipped settings bundle renders model/preset/permissions and saves then removes a project', async t => {
  const f = await fixture(); t.after(() => f.close());
  let tree = await f.flush();
  assert.match(text(tree), /0 个项目/);
  click(tree, '添加第一个项目'); tree = await f.flush();
  const preset = control(tree, 'agent_preset');
  assert.equal(preset.props.value, 'no-subagent');
  assert.deepEqual(Array.from(preset.children, text), ['标准模式', 'NoSubAgent']);
  const permission = control(tree, 'permission_mode');
  assert.equal(permission.props.value, 'workspace-write');
  assert.deepEqual(Array.from(permission.children, text), ['仅可查看', '工作区内修改', '自动审查', '完全权限']);
  for (const [name, value] of [['id', 'news'], ['name', '新闻'], ['callback_url', 'http://127.0.0.1/results'], ['model', JSON.stringify(['deepseek', 'chat'])]]) {
    control(tree, name).props.onChange({ target: { value } }); tree = f.render();
  }
  await tree.props.onSubmit({ preventDefault() {} }); tree = await f.flush();
  assert.equal(f.snapshot().value.projects.news.agent_preset, 'no-subagent');
  assert.equal(f.snapshot().value.projects.news.max_concurrency, 0);
  const heading = nodes(tree).find(node => node.props.className === 'terms-project-heading'); heading.props.onClick(); tree = f.render();
  assert.equal(control(tree, 'workspace_path').props.value, 'F:/work/news');
  assert.equal(control(tree, 'workspace_path').props.disabled, true);
  assert.equal(control(tree, 'id').props.disabled, true);
  click(tree, '移除项目'); tree = f.render(); click(tree, '确认移除'); tree = f.render();
  // Removing a row alone is only a draft; the explicit save must remove persisted config.
  assert.ok(f.snapshot().value.projects.news);
  await tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(f.snapshot().value.projects, {});
  assert.match(text(f.render()), /0 个项目/);
});

test('saved manual paths display the host resolved path and refresh with settings', async t => {
  const paths = { news: 'C:/Users/test/Documents/news' };
  const f = await fixture(paths); t.after(() => f.close());
  const value = { projects: { news: { name: '新闻', workspace_path: '~/Documents/news', agent_preset: 'standard' } } };
  f.change({ revision: 2, value });
  let tree = await f.flush();
  nodes(tree).find(node => node.props.className === 'terms-project-heading').props.onClick(); tree = f.render();
  assert.equal(control(tree, 'workspace_path').props.value, paths.news);
  assert.equal(control(tree, 'workspace_path').props.disabled, true);
  // A later host response is selected by project ID, independent of raw configuration text.
  paths.news = 'D:/canonical/news'; f.change({ revision: 3, value }); tree = await f.flush();
  nodes(tree).find(node => node.props.className === 'terms-project-heading').props.onClick(); tree = f.render();
  assert.equal(control(tree, 'workspace_path').props.value, paths.news);
  assert.equal(f.snapshot().value.projects.news.workspace_path, '~/Documents/news');
});

test('shipped settings bundle renders unavailable and read-only states without editable controls', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.flush();
  f.change({ status: 'unavailable', writable: false, revision: 2 });
  assert.match(text(f.render()), /当前无法读取插件配置/);
  f.change({ status: 'ready', writable: false, revision: 3 });
  const tree = f.render(); assert.match(text(tree), /配置为只读/);
  assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === '添加第一个项目').props.disabled, true);
});
