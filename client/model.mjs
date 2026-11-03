import { DEFAULT_CONFIG, DEFAULT_PROJECT, FIELDS, validateDraft } from './fields.mjs';

/** Draft lifecycle is independent of React and the dsh settings transport. */
export function createEditor(form) {
  let serial = 0, original = {}, preset = '', disposed = false;
  let state = { status: 'loading', writable: false, draft: null, revision: undefined, dirty: false, saving: false,
    saved: false, conflict: false, errors: {}, message: '' };
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const reset = () => {
    const snapshot = form.getSnapshot(), config = { ...DEFAULT_CONFIG, ...structuredClone(snapshot.value ?? {}) };
    original = config.projects;
    const rows = Object.entries(original).map(([id, project]) => ({ ...DEFAULT_PROJECT, ...project,
      id, originalId: id, key: 'project-' + ++serial, request_token: '', tokenEdited: false,
      tokenSet: Boolean(project.request_token) || (snapshot.secrets ?? []).some(secret => secret.set && JSON.stringify(secret.path) === JSON.stringify(['projects', id, 'request_token'])),
      callback_headers: Object.keys(project.callback_headers ?? {}).length ? JSON.stringify(project.callback_headers, null, 2) : '',
    }));
    publish({ draft: { ...config, rows }, revision: snapshot.revision, status: snapshot.status, writable: snapshot.writable,
      dirty: false, saved: false, conflict: false, errors: {}, message: '' });
  };
  const sync = () => {
    if (disposed) return;
    const snapshot = form.getSnapshot();
    if (!state.draft || !state.dirty && !state.saving && snapshot.revision !== state.revision) reset();
    else publish({ status: snapshot.status, writable: snapshot.writable, conflict: state.revision !== snapshot.revision });
  };
  const unsubscribe = form.subscribe(sync);
  reset();
  const edit = draft => {
    if (state.writable && !state.saving) publish({ draft, dirty: true, saved: false, errors: {}, message: '' });
  };
  const updateRow = (key, change) => edit({ ...state.draft, rows: state.draft.rows.map(row => row.key === key ? change(row) : row) });
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); },
    discard() { if (!state.saving) reset(); },
    field(name, value) { edit({ ...state.draft, [name]: value }); },
    project(key, name, value) {
      if (state.draft.rows.some(row => row.key === key && row.originalId && ['id', 'workspace_path'].includes(name))) return;
      updateRow(key, row => ({ ...row, [name]: value, ...(name === 'request_token' ? { tokenEdited: true } : {}) }));
    },
    selectModel(key, provider, model) { updateRow(key, row => ({ ...row, provider, model })); },
    setDefaultPreset(id) {
      preset = id || '';
      if (preset && state.draft?.rows.some(row => !row.agent_preset)) edit({ ...state.draft, rows: state.draft.rows.map(row => row.agent_preset ? row : { ...row, agent_preset: preset }) });
    },
    add() {
      const key = 'project-' + ++serial;
      edit({ ...state.draft, rows: [...state.draft.rows, { ...DEFAULT_PROJECT, id: '', key, agent_preset: preset }] });
      return key;
    },
    remove(key) { edit({ ...state.draft, rows: state.draft.rows.filter(row => row.key !== key) }); },
    async save() {
      if (!state.dirty || state.saving || !state.writable || state.status !== 'ready') return false;
      if (state.conflict) { publish({ message: '配置已被其他页面修改。请重新载入后再编辑。' }); return false; }
      const { config, errors } = validateDraft(state.draft);
      if (Object.keys(errors).length) { publish({ errors, message: '请修正标出的字段后再保存。' }); return false; }
      publish({ saving: true, errors: {}, message: '' });
      try {
        const ops = [{ op: 'set', path: ['api_prefix'], value: config.api_prefix }];
        for (const id of Object.keys(original)) if (!Object.hasOwn(config.projects, id)) ops.push({ op: 'unset', path: ['projects', id] });
        for (const row of state.draft.rows) {
          const id = row.id.trim(), project = config.projects[id];
          if (!Object.hasOwn(original, id)) { ops.push({ op: 'set', path: ['projects', id], value: project }); continue; }
          // Host reads redact secrets. Never replace an existing project object wholesale.
          for (const { name } of FIELDS) {
            if (name === 'workspace_path' || name === 'request_token' && !row.tokenEdited) continue;
            const path = ['projects', id, name];
            ops.push(project[name] === undefined ? { op: 'unset', path } : { op: 'set', path, value: project[name] });
          }
        }
        const accepted = await form.mutate(ops, state.revision);
        if (!disposed) {
          if (accepted) { reset(); publish({ saved: true }); }
          else publish({ message: '保存未被接受，编辑内容已保留。请检查配置权限或重新载入最新配置。' });
        }
        return accepted;
      } catch (error) {
        let reason = error instanceof Error ? error.message : '无法连接 dsh';
        for (const project of Object.values(config.projects)) for (const secret of [project.request_token, ...Object.values(project.callback_headers ?? {})]) if (secret) reason = reason.split(secret).join('[已隐藏凭证]');
        if (!disposed) publish({ message: '保存失败，编辑内容已保留。原因：' + reason.slice(0, 600) });
        return false;
      } finally { if (!disposed) publish({ saving: false }); }
    },
  };
}
