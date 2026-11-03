export const modelKey = (provider, model) => JSON.stringify([provider, model]);
export function catalogGroups(value) {
  return (value?.groups ?? []).map(group => ({ id: group.id, name: group.name,
    models: group.models.map(model => ({ provider: group.id, model: model.id, name: model.name || model.id, key: modelKey(group.id, model.id) })),
  })).filter(group => group.models.length);
}
/** Keep loaded choices during failures and discard late responses from older refreshes. */
export function createCatalog(read, project = value => ({ groups: catalogGroups(value), failures: value.failures ?? [] })) {
  let state = { status: 'idle', groups: [], failures: [] }, generation = 0, closed = false, pending;
  const listeners = new Set();
  const emit = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const refresh = (clear = false) => {
    if (closed) return Promise.resolve();
    const version = ++generation;
    emit({ status: 'loading', ...(clear ? { groups: [], failures: [] } : {}) });
    pending = Promise.resolve().then(read).then(response => {
      if (!response.ok) throw new Error('Catalog unavailable');
      if (!closed && version === generation) emit({ status: 'ready', ...project(response.value) });
    }).catch(() => { if (!closed && version === generation) emit({ status: 'error' }); })
      .finally(() => { if (version === generation) pending = undefined; });
    return pending;
  };
  return { getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh, load: () => pending ?? (state.status === 'ready' ? Promise.resolve() : refresh()),
    dispose() { closed = true; generation++; listeners.clear(); } };
}
