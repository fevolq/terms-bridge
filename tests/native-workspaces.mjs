import { pathToFileURL } from 'node:url';
import { createWorkspaceDirectory } from '../dist/dsh/directories.js';

// Native controller, package locator and directory resolver from the test installation.
export async function mountNativeWorkspaces(ctx, load, requireHost, documentsDirectory) {
  const mount = async (name, config = {}) => {
    const plugin = await load(name);
    await ctx.plugin(plugin.default ?? plugin, config).await();
  };
  if (!ctx.get('profileContext')) ctx.provide('profileContext', { dir: documentsDirectory, home: documentsDirectory });
  if (!ctx.get('settings')) ctx.provide('settings', {
    writable: true,
    // Native services register page policies as effects; these tests do not render native settings forms.
    configure() { return () => {}; },
  });
  if (!ctx.get('typert')) await mount('dsh-typert-registry');
  if (!ctx.get('remoteAccess')) await mount('dsh-api-remote-access');
  if (!ctx.get('pluginPackages')) {
    const { PluginPackages } = await load('dsh-app-boot');
    await ctx.plugin(PluginPackages).await();
    ctx.baseUrl = pathToFileURL(requireHost.resolve('@deepseek-ai/dsh/package.json')).href;
  }
  await mount('dsh-api-workspace-controller', { documentsDirectory });
  const directory = createWorkspaceDirectory(ctx); await directory.load(); return directory;
}
