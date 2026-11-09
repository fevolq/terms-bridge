/** Settings travel over DSH's owner-authenticated Remote connection, not profile mutation. */
export function settingsForm(ctx) {
  let state = { status: 'loading', writable: false, value: {}, revision: undefined, secrets: [], connection: 0 };
  let closed = false, generation = 0, writing = false, reading;
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const accept = view => {
    if (closed || state.revision !== undefined && view.revision < state.revision) return;
    publish({ ...view, status: 'ready' });
  };
  const refresh = () => {
    if (closed || writing) return Promise.resolve();
    if (reading) return reading;
    const request = ++generation;
    const work = (async () => {
      try {
        const response = await ctx.remote.termsBridge.settings();
        if (!response.ok) throw new Error(response.error?.message || '无法读取项目配置');
        if (!closed && request === generation) accept(response.value);
      } catch {
        if (!closed && request === generation) publish({ status: 'unavailable', writable: false });
      }
    })();
    const pending = work.finally(() => { if (reading === pending) reading = undefined; });
    reading = pending; return pending;
  };
  const reset = () => {
    if (closed) return;
    // A new connection may point at a restored database with a lower revision.
    generation++; reading = undefined; writing = false;
    publish({ status: 'loading', writable: false, value: {}, revision: undefined, secrets: [], connection: state.connection + 1 });
    void refresh();
  };
  const unsubscribe = ctx.on?.('connection/reset', reset);
  const timer = setInterval(() => { void refresh(); }, 2000); timer.unref?.();
  const dispose = () => { closed = true; generation++; clearInterval(timer); unsubscribe?.(); listeners.clear(); };
  ctx.effect?.(() => dispose);
  void refresh();
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, dispose,
    async mutate(ops, revision) {
      if (closed || writing) throw new Error('配置保存不可用');
      writing = true; reading = undefined; const request = ++generation;
      try {
        const response = await ctx.remote.termsBridge.mutate(ops, revision);
        if (closed || request !== generation) throw new Error('连接已重置，请重新载入配置后确认保存结果');
        if (!response.ok) throw new Error(response.error?.message || '无法保存项目配置');
        const result = response.value;
        if (result.view) accept(result.view);
        if (!result.accepted) throw Object.assign(new Error(result.error?.message || '配置保存被拒绝'), { code: result.error?.code });
        return true;
      } catch (error) {
        // A lost response may follow a successful commit. Refresh only the current connection.
        if (!closed && request === generation) { writing = false; await refresh(); }
        throw error;
      } finally { if (request === generation) writing = false; }
    },
  };
}
