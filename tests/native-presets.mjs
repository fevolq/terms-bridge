import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real preset composition and permission services; no OS commands are executed.
export async function mountNativePresets(ctx, mount, load, requireHost, root, fibers) {
  const { Service } = await load('cordis');
  class Shell extends Service {
    constructor(c) { super(c, 'shell'); this.sandboxMode = 'workspace-write'; }
  }
  class WorkingDirectory extends Service {
    constructor(c) { super(c, 'workingDirectory'); }
    async ensure() { return root; }
  }
  for (const service of [Shell, WorkingDirectory]) {
    const fiber = ctx.plugin(service); fibers.push(fiber); await fiber.await();
  }
  await mount('cordis-plugin-loader');
  await mount('dsh-user-approval');
  await mount('dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root });
  // Use the host bundle's actual preset table, including read-only. Keep !!js
  // expressions as strings: this fixture only reads the permission entry.
  const base = await readFile(requireHost.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8');
  const patches = requireHost('yaml').parse(base, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  });
  const permission = patches.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'permission');
  if (!permission?.config?.presets?.['read-only']) throw new Error('dsh-base must provide the read-only permission preset');
  await mount('dsh-permission-presets', { ...permission.config, defaultPreset: 'danger-full-access' });
  await mount('dsh-agent-preset-registry', { default: 'test-default' });
  const toolUrl = pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-tools')).href;
  const fixturePath = join(root, 'preset-tools.mjs');
  await writeFile(fixturePath, `
import { defineTool } from ${JSON.stringify(toolUrl)};
export const inject = ['tools', 'skills'];
export function apply(ctx) {
  ctx.skills.register({ name: 'business-skill', description: 'Process business requests.', content: 'Use the available business tools.' });
  for (const name of ['preset_probe', 'ask_user_question']) ctx.tools.register(defineTool({
    name, description: 'Test preset tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'preset tool executed'; }
  }));
}
`);
  const plugins = [
    { name: pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-tool-skill')).href },
    { name: pathToFileURL(fixturePath).href },
  ];
  for (const id of ['test-default', 'test-specific']) await mount('dsh-agent-preset', { id, plugins });
}
