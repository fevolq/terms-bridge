import { FIELDS } from './fields.mjs';
import { createEditor } from './model.mjs';
import { createCatalog, modelKey } from './catalog.mjs';
import { settingsForm } from './transport.mjs';
import { LIMITS } from '../dist/shared/rules.js';
import { WORKSPACES_REMOTE } from '../dist/shared/workspaces.js';

export async function mountPanel(React, ctx, css) {
  await ctx.remote.$mount(WORKSPACES_REMOTE);
  await ctx.inject(['remote.termsBridge'], scope => mountSettings(React, scope, css)).await();
}

function mountSettings(React, ctx, css) {
  const h = React.createElement, editor = createEditor(settingsForm(ctx));
  const models = createCatalog(() => ctx.remote.session.modelCatalog());
  const presets = createCatalog(() => ctx.remote.agentPresets.list(), value => ({ presets: value.presets }));
  const titles = { standard: '标准模式', ptc: 'PTC 模式', minimal: '极简模式', cordis: '创造模式' };
  const workspaces = createCatalog(() => ctx.remote.termsBridge.workspaces(), paths => ({ paths }));
  for (const resource of [editor, models, presets, workspaces]) ctx.effect(() => () => resource.dispose());
  ctx.on('connection/reset', () => { void models.refresh(true); void presets.refresh(true); void workspaces.refresh(true); });
  for (const event of ['llm/adapters-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated']) ctx.remote.$on(event, () => { void models.refresh(); });
  ctx.remote.$on('settings/document-updated', () => { void presets.refresh(); });
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const mark = () => {
      for (const button of document.querySelectorAll('[data-shortcut-modal="settings"] nav button')) if (button.textContent.trim() === '项目接入') button.classList.add('terms-navigation');
    };
    const observer = new MutationObserver(mark); observer.observe(document.body, { childList: true, subtree: true }); mark();
    return () => { style.remove(); observer.disconnect(); for (const button of document.querySelectorAll('.terms-navigation')) button.classList.remove('terms-navigation'); };
  });
  const button = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);
  const useStore = store => React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  function Panel() {
    const state = useStore(editor), modelState = useStore(models), presetState = useStore(presets);
    const workspaceState = useStore(workspaces);
    const [expanded, expand] = React.useState(null), [removing, remove] = React.useState(null);
    React.useEffect(() => { void models.load(); void presets.load(); }, []);
    React.useEffect(() => { void workspaces.refresh(); }, [state.revision]);
    React.useEffect(() => {
      if (presetState.status === 'ready') editor.setDefaultPreset(presetState.presets?.find(item => item.isDefault && !item.broken)?.id);
    }, [presetState, state.draft]);
    const disabled = !state.writable || state.saving || state.status !== 'ready';
    const add = () => { expand(editor.add()); remove(null); };
    const label = (id, field) => h('div', { className: 'terms-label' },
      h('label', { htmlFor: id }, field.label, field.required && h('span', { className: 'terms-required' }, ' *')),
      field.tip && h('button', { type: 'button', className: 'terms-tip', title: field.tip, 'aria-label': field.label + '说明' }, '?'));
    function field(row, spec) {
      const key = row ? row.key + '.' + spec.name : spec.name, id = 'terms-' + key;
      let value = row ? row[spec.name] : state.draft[spec.name];
      const locked = Boolean(row?.originalId && ['id', 'workspace_path'].includes(spec.name));
      const savedWorkspace = spec.name === 'workspace_path' && locked;
      if (savedWorkspace) value = workspaceState.paths?.[row.originalId] ?? '';
      const error = state.errors[key] || (savedWorkspace && workspaceState.status === 'error' ? '无法读取工作区路径，请刷新页面重试。' : ''),
        hint = savedWorkspace ? '项目保存后工作区路径不可修改。' : spec.hint;
      const props = { id, value: value ?? '', disabled: disabled || locked, 'aria-invalid': Boolean(error), 'aria-required': spec.required || undefined,
        'aria-describedby': error || hint ? id + '-hint' : undefined,
        onChange: event => row ? editor.project(row.key, spec.name, event.target.value) : editor.field(spec.name, event.target.value) };
      let input;
      if (spec.options) input = h('select', props, spec.options.map(([value, text]) => h('option', { key: value, value }, text)));
      else if (spec.json) input = h('textarea', { ...props, rows: 4, placeholder: spec.placeholder, autoComplete: 'off', spellCheck: false });
      else input = h('input', { ...props, type: spec.secret ? 'password' : spec.min !== undefined ? 'number' : 'text',
        min: spec.min, max: spec.min !== undefined ? spec.max ?? LIMITS.numeric : undefined, step: spec.min !== undefined ? 1 : undefined,
        placeholder: savedWorkspace ? '正在读取工作区路径…' : spec.secret && row.tokenSet ? row.tokenEdited && !row.request_token ? '保存后清除令牌' : '已设置，输入新令牌可替换' : spec.placeholder,
        autoComplete: spec.secret ? 'new-password' : 'off' });
      return h('div', { className: 'terms-field' + (spec.wide ? ' terms-wide' : ''), key: spec.name }, label(id, spec), input,
        spec.secret && row.tokenSet && button('清除令牌', () => editor.project(row.key, spec.name, ''), { disabled: disabled || row.tokenEdited && !row.request_token, className: 'terms-small' }),
        (error || hint) && h('span', { id: id + '-hint', className: error ? 'terms-error' : 'terms-help' }, error || hint));
    }
    function picker(row, kind) {
      const model = kind === 'model', source = model ? modelState : presetState;
      const options = model ? source.groups.flatMap(group => group.models) : source.presets ?? [];
      const key = row.key + '.' + (model ? 'model' : 'agent_preset'), id = 'terms-' + key;
      const selected = model ? row.provider && row.model ? modelKey(row.provider, row.model) : '' : row.agent_preset || '';
      const missing = Boolean(selected && !options.some(item => (model ? item.key : item.id) === selected));
      const error = state.errors[key] || (model && state.errors[row.key + '.provider']);
      const title = model ? '模型' : 'Agent 预设';
      const choose = event => {
        if (!model) return editor.project(row.key, 'agent_preset', event.target.value);
        const item = options.find(item => item.key === event.target.value);
        if (item) editor.selectModel(row.key, item.provider, item.model);
      };
      return h('div', { key: kind, className: 'terms-field' + (model ? ' terms-wide' : '') },
        h('div', { className: 'terms-label' }, h('label', { htmlFor: id }, title, model && h('span', { className: 'terms-required' }, ' *')),
          button('刷新' + (model ? '模型' : '预设'), () => { void (model ? models : presets).refresh(); }, { className: 'terms-small', disabled: source.status === 'loading' })),
        h('select', { id, value: selected, disabled: disabled || source.status !== 'ready', onChange: choose, 'aria-invalid': Boolean(error), 'aria-required': true },
          !selected && h('option', { value: '', disabled: true }, source.status === 'loading' ? '正在加载…' : '请选择' + title),
          missing && h('option', { value: selected, disabled: true }, (model ? row.model : row.agent_preset) + '（暂不可用）'),
          model ? source.groups.map(group => h('optgroup', { key: group.id, label: group.name || group.id }, group.models.map(item => h('option', { key: item.key, value: item.key }, item.name)))) :
            options.map(item => h('option', { key: item.id, value: item.id, disabled: Boolean(item.broken) }, (item.name ?? titles[item.id] ?? item.id) + (item.broken ? '（不可用）' : '')))),
        (error || source.status === 'error' || missing || model && source.failures.length > 0) && h('span', { className: error ? 'terms-error' : 'terms-help' }, error || (missing ? '原选择当前不可用，配置已保留。' : '部分列表未能读取，请刷新重试。')));
    }
    async function save(event) {
      event.preventDefault(); await editor.save();
      const key = Object.keys(editor.getSnapshot().errors)[0];
      if (key) {
        if (key.includes('.')) expand(key.split('.')[0]);
        requestAnimationFrame(() => document.getElementById('terms-' + key.replace(/\.provider$/, '.model'))?.focus());
      }
    }
    if (!state.draft || state.status === 'loading') return h('div', { className: 'terms-panel', role: 'status' }, '正在读取项目接入配置…');
    if (state.status === 'unavailable') return h('div', { className: 'terms-panel', role: 'alert' }, '当前无法读取插件配置。请确认插件已启用，然后刷新页面。');
    return h('form', { className: 'terms-panel', onSubmit: save, noValidate: true },
      h('header', null, h('h2', null, '项目接入'), h('span', { className: 'terms-help' }, state.draft.rows.length + ' 个项目')),
      h('div', { className: 'terms-body' },
        h('div', { className: 'terms-label terms-section' }, h('h3', null, '项目配置'), button('＋ 新增项目', add, { disabled })),
        state.draft.rows.length === 0 && h('div', { className: 'terms-empty' }, h('span', { 'aria-hidden': true }, '⇄'), h('strong', null, '还没有接入项目'), button('添加第一个项目', add, { disabled, className: 'terms-primary' })),
        state.draft.rows.map(row => h('section', { className: 'terms-project', key: row.key },
          button(h(React.Fragment, null, h('span', null, h('strong', null, row.name || row.id || '新项目'), h('small', null, row.id || '填写项目 ID')), h('span', { 'aria-hidden': true }, expanded === row.key ? '⌃' : '⌄')),
            () => { expand(expanded === row.key ? null : row.key); remove(null); }, { className: 'terms-project-heading', 'aria-expanded': expanded === row.key }),
          expanded === row.key && h('div', { className: 'terms-project-body' },
            h('div', { className: 'terms-grid' }, field(row, { name: 'id', label: '项目 ID', required: true, placeholder: '例如：news-service' }),
              FIELDS.filter(spec => !spec.advanced && !spec.hidden).map(spec => ['model', 'agent_preset'].includes(spec.name) ? picker(row, spec.name) : field(row, spec))),
            h('details', { open: FIELDS.some(spec => spec.advanced && state.errors[row.key + '.' + spec.name]) ? true : undefined }, h('summary', null, '并发与超时'), h('div', { className: 'terms-grid' }, FIELDS.filter(spec => spec.advanced).map(spec => field(row, spec)))),
            removing === row.key ? h('div', { role: 'alert' }, h('p', null, '确认移除此项目？请先暂停提交并处理完未完成任务，否则无法保存。工作区、文件和会话均保留。'),
              button('取消', () => remove(null), { disabled }), button('确认移除', () => { editor.remove(row.key); remove(null); }, { disabled, className: 'terms-danger' })) :
              button('移除项目', () => remove(row.key), { disabled, className: 'terms-danger' })))),
        h('details', { className: 'terms-api', open: state.errors.api_prefix ? true : undefined }, h('summary', null, '接口设置'), h('div', { className: 'terms-grid' }, field(null, { name: 'api_prefix', label: '任务接口路径', wide: true }))),
        !state.writable && h('p', { role: 'alert', className: 'terms-error' }, '当前部署的配置为只读。'),
        state.conflict && h('p', { role: 'alert', className: 'terms-error' }, '配置已在其他页面发生变化。请重新载入后再编辑。')),
      h('footer', null, h('span', { className: state.message ? 'terms-error' : 'terms-help', role: state.message ? 'alert' : 'status' }, state.message || (state.dirty ? '有未保存的修改' : '')),
        h('div', { className: 'terms-actions' }, button(state.conflict ? '重新载入' : '放弃修改', () => { editor.discard(); expand(null); remove(null); }, { disabled: !state.dirty || state.saving }),
          h('button', { type: 'submit', className: 'terms-primary', disabled: disabled || !state.dirty || state.conflict }, state.saving ? '保存中…' : '保存配置'))));
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'terms-bridge', order: 50, label: () => '项目接入', inject: () => ({}) }, Panel));
}
