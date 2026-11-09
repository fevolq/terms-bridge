import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { parseConfig } from '../dist/projects/config.js';
import { resolveProjects, validateProjectWorkspaces } from '../dist/projects/workspaces.js';
import { DEFAULT_PROJECT, validateDraft } from '../client/fields.mjs';

const project = { provider:'test', model:'model', agent_preset:'standard', max_concurrency:1, callback_url:'https://example.com/results' };

test('home-relative workspace paths are accepted by the editor and resolved on the dsh host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terms-home-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace_path = '~/' + relative(homedir(), root).replaceAll('\\', '/');
  const checked = validateDraft({ api_prefix: '/api/terms-bridge', rows: [{ ...DEFAULT_PROJECT, ...project, workspace_path, key: 'a', id: 'news' }] });
  assert.deepEqual(checked.errors, {});
  const host = { workspaceRegistry: { list: () => [], create: async path => ({ id: 'news', path, attachSession: async () => {} }) } };
  const resolved = await resolveProjects(host, parseConfig(checked.config));
  assert.equal(resolved.get('news').workspace_path, await realpath(root));
  const duplicate = parseConfig({ projects: { first: { ...project, workspace_path }, second: { ...project, workspace_path: root } } });
  await assert.rejects(resolveProjects(host, duplicate), /工作区路径.*重复/);
});
test('blank workspace and tokens are optional in native configuration and settings editor', () => {
  const config=parseConfig({projects:{news:{...project,workspace_path:'',request_token:'',callback_headers: {}}}});
  assert.equal(config.projects.news.workspace_path,undefined);
  assert.equal(config.projects.news.request_token,undefined);
  const checked=validateDraft({api_prefix:'/api/terms-bridge',rows:[{...DEFAULT_PROJECT,...project,key:'a',id:'news'}]});
  assert.deepEqual(checked.errors,{});
  assert.equal(checked.config.projects.news.workspace_path,undefined);
  assert.equal(checked.config.projects.news.request_token,undefined);
  assert.throws(()=>parseConfig({projects:{news:{...project,request_token:'bad token'}}}));
  assert.throws(()=>parseConfig({projects:{news:{...project,callback_headers: { Authorization: 'Bearer bad\nheader' }}}}));
  assert.throws(()=>parseConfig({projects:{news:{...project,request_token_env:'OLD_ENV'}}}));
  assert.equal(parseConfig({projects:{news:{...project,request_token:'literal.token-123'}}}).projects.news.request_token,'literal.token-123');
});

test('automatic workspaces are idempotent siblings of the default workspace and stay isolated', async t => {
  const root=await mkdtemp(join(tmpdir(),'terms-workspace-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'default-workspace');await mkdir(home);
  const created=[];
  const host={workspaceRegistry:{list:()=>[{path:home,id:'default'}],create:async(path)=>{created.push(path);return{id:path,path,attachSession:async()=>{}};}}};
  const config=parseConfig({projects:{first:{...project,name:'测试'},second:{...project,name:'测试'}}});
  const one=await resolveProjects(host,config,undefined,()=>root);const two=await resolveProjects(host,config,undefined,()=>root);
  assert.equal(one.get('first').workspace_path,await realpath(join(root,'first')));
  assert.equal(one.get('second').workspace_path,await realpath(join(root,'second')));
  assert.equal(one.get('first').workspace_path,two.get('first').workspace_path);
  assert.equal('workspace_id' in one.get('first'), false);
  assert.equal((await stat(join(root,'first'))).isDirectory(),true);
  assert.notEqual(one.get('first').workspace_path,one.get('second').workspace_path);
  await assert.rejects(resolveProjects(host,parseConfig({projects:{'default-workspace':project}}),undefined,()=>root),/cannot use automatic/);
  await assert.rejects(resolveProjects(host,parseConfig({projects:{first:{...project},second:{...project,workspace_path:join(root,'first')}}}),undefined,()=>root),/工作区路径.*重复/);
  await assert.rejects(resolveProjects({workspaceRegistry:{list:()=>[]}},config),/DSH workspace directory is unavailable/);
});

test('workspace names may repeat while resolved project paths must remain distinct', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terms-duplicate-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taken = join(root, 'taken'), fresh = join(root, 'fresh');
  const sameDirectory = join(root, 'other', 'taken');
  for (const path of [taken, fresh, sameDirectory]) await mkdir(path, { recursive: true });
  const config = p => parseConfig({ projects: { news: { ...project, ...p } } });
  const empty = new Map();
  const sameTitle = validateProjectWorkspaces(config({ name: '已存在的工作区', workspace_path: fresh }), empty, () => root);
  assert.equal(sameTitle.get('news').name, '已存在的工作区');
  const sameDirectoryName = validateProjectWorkspaces(config({ workspace_path: sameDirectory }), empty, () => root);
  assert.equal(sameDirectoryName.get('news').workspace_path, await realpath(sameDirectory));
  const reused = validateProjectWorkspaces(config({ workspace_path: taken + '/..' + '/taken' }), empty, () => root);
  assert.equal(reused.get('news').workspace_path, await realpath(taken));
  if (process.platform === 'win32') validateProjectWorkspaces(config({ workspace_path: taken.toUpperCase() }), empty, () => root);
  assert.throws(() => validateProjectWorkspaces(parseConfig({ projects: {
    first: { ...project, workspace_path: taken }, second: { ...project, workspace_path: taken },
  } }), empty, () => root), /工作区路径.*重复/);
  const planned = validateProjectWorkspaces(config({}), empty, () => root);
  assert.equal(planned.get('news').workspace_path, join(await realpath(root), 'news'));
  await assert.rejects(stat(join(root, 'news')), { code: 'ENOENT' });
  const sameNames = validateProjectWorkspaces(parseConfig({ projects: {
    first: { ...project, name: '同名工作区', workspace_path: fresh },
    second: { ...project, name: '同名工作区' },
  } }), empty, () => root);
  assert.equal(sameNames.get('first').name, sameNames.get('second').name);
  assert.notEqual(sameNames.get('first').workspace_path, sameNames.get('second').workspace_path);
});

test('existing projects can save and reopen their own workspace but cannot claim another registered workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terms-own-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const own = join(root, 'own'), other = join(root, 'other');
  await mkdir(own); await mkdir(other);
  const registered = [{ id: 'own', path: await realpath(own), title: '业务' }, { id: 'other', path: await realpath(other), title: '其他业务' }];
  const host = { workspaceRegistry: { list: () => registered, create: async path => ({ ...registered.find(w => w.path === path), attachSession: async () => {} }) } };
  const config = parseConfig({ projects: { news: { ...project, name: '业务', workspace_path: own } } });
  const current = await resolveProjects(host, config, undefined, () => root);
  const changed = structuredClone(config); changed.projects.news.model = 'updated-model';
  validateProjectWorkspaces(changed, current);
  const saved = await resolveProjects(host, changed);
  assert.equal(saved.get('news').workspace_path, await realpath(own)); assert.equal(saved.get('news').model, 'updated-model');
  changed.projects.news.workspace_path = other;
  assert.equal(validateProjectWorkspaces(changed, current).get('news').workspace_path, current.get('news').workspace_path);
});

test('existing project edits retain the saved binding without resolving a replacement path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terms-locked-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'default-workspace'), fresh = join(root, 'fresh');
  await mkdir(home); await mkdir(fresh);
  const registered = [{ id: 'default', path: await realpath(home), title: 'default-workspace' }];
  const host = { workspaceRegistry: { list: () => registered, create: async (path, title) => {
    let workspace = registered.find(w => w.path === path);
    if (!workspace) { workspace = { id: path, path, title }; registered.push(workspace); }
    return { ...workspace, attachSession: async () => {} };
  } } };
  const config = parseConfig({ projects: { news: project } });
  const current = await resolveProjects(host, config, undefined, () => root);
  validateProjectWorkspaces(config, current);
  const equivalent = structuredClone(config); equivalent.projects.news.workspace_path = current.get('news').workspace_path;
  validateProjectWorkspaces(equivalent, current);
  const changed = structuredClone(config);
  changed.projects.news = { ...changed.projects.news, name: '新的名称', workspace_path: fresh };
  assert.equal(validateProjectWorkspaces(changed, current).get('news').workspace_path, current.get('news').workspace_path);
  assert.equal((await resolveProjects(host, changed, current)).get('news').workspace_path, current.get('news').workspace_path);
  assert.equal(registered.length, 2);
  assert.equal(current.get('news').workspace_path, await realpath(join(root, 'news')));
});

test('only new project configurations register workspaces; edits and reloads retain deleted registrations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terms-workspace-lifecycle-'));
  t.after(() => {
    const within = relative(tmpdir(), root);
    assert(within && !within.startsWith('..') && !isAbsolute(within));
    return rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'default-workspace'); await mkdir(home);
  const registered = new Map([['default', { id: 'default', path: await realpath(home) }]]);
  const creations = [];
  const host = { workspaceRegistry: { list: () => [...registered.values()], create: async (path, title) => {
    creations.push(path);
    const existing = [...registered.values()].find(item => item.path === path);
    if (existing) return existing;
    const workspace = { id: String(creations.length), path: await realpath(path), title, attachSession: async () => {} };
    registered.set(workspace.id, workspace); return workspace;
  } } };
  const config = parseConfig({ projects: { news: project } });
  const first = await resolveProjects(host, config, undefined, () => root);
  assert.equal(creations.length, 1);
  const originalId = [...registered.values()].find(value => value.path === first.get('news').workspace_path).id;
  registered.delete(originalId);
  const edited = structuredClone(config); edited.projects.news.model = 'changed-model';
  const next = await resolveProjects(host, edited, first);
  assert.equal(next.get('news').model, 'changed-model');
  assert.equal(creations.length, 1, 'editing a project must not restore its deleted workspace');
  assert.equal(registered.size, 1);

  // A restarted plugin loads only the saved directory binding, not a live workspace entity.
  const restored = new Map([['news', {
    workspace_path: next.get('news').workspace_path,
  }]]);
  registered.delete('default');
  const reopened = await resolveProjects(host, edited, restored);
  assert.equal(reopened.get('news').workspace_path, first.get('news').workspace_path);
  assert.equal(creations.length, 1, 'reload must not register an existing project or require the default workspace');

  edited.projects.added = { ...edited.projects.news };
  const added = await resolveProjects(host, edited, reopened, () => root);
  assert.equal(creations.length, 2);
  assert.equal(registered.size, 1);
  assert.ok([...registered.values()].some(value => value.path === added.get('added').workspace_path));
  assert.equal(registered.has(originalId), false);
});
