const namespace = 'terms-bridge';
export function settingsForm(ctx) {
  const form = ctx.configForms.get(namespace), mirror = ctx.configForms.describe();
  return {
    getSnapshot: () => ({ ...form.getSnapshot(), secrets: mirror.getSnapshot?.().view?.namespaces.find(item => item.ns === namespace)?.secrets ?? [] }),
    subscribe: listener => form.subscribe(listener),
    async mutate(ops, revision) {
      const response = await ctx.remote.settings.mutate(namespace, ops, revision);
      if (response.ok) { mirror.acceptView(response.value); return true; }
      const latest = await ctx.remote.settings.describe().catch(() => undefined);
      const view = latest?.ok && latest.value.namespaces.find(item => item.ns === namespace);
      if (view) mirror.acceptView(view);
      throw Object.assign(new Error(response.error?.message || 'dsh 拒绝了配置保存请求'), { code: response.error?.code });
    },
  };
}
