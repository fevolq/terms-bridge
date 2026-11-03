import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), dist = resolve(root, 'dist');
// Remove only this project's generated output, including modules removed during development.
if (relative(root, dist) !== 'dist' || !isAbsolute(dist)) throw new Error('Invalid build output directory');
await rm(dist, { recursive: true, force: true });
const build = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sources = ['dist/shared/rules.js', 'dist/shared/workspaces.js', 'client/fields.mjs', 'client/model.mjs', 'client/catalog.mjs', 'client/transport.mjs', 'client/panel.mjs'];
const modules = [];
for (const file of sources) {
  const source = await readFile(resolve(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  modules.push(`${JSON.stringify(posix.normalize(file))}: function(module, exports, require) {\n${code}\n}`);
}
const css = await readFile(resolve(root, 'client/panel.css'), 'utf8');
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'client.js'), `// Generated settings extension. React and host services are supplied by dsh.
window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory(hostRequire) {
  const modules = {${modules.join(',\n')}}, cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) return hostRequire(id);
    const module = cache[id] = { exports: {} };
    modules[id](module, module.exports, name => {
      if (!name.startsWith('.')) return hostRequire(name);
      const parts = (id.slice(0, id.lastIndexOf('/') + 1) + name).split('/'), normalized = [];
      for (const part of parts) { if (part === '..') normalized.pop(); else if (part !== '.' && part) normalized.push(part); }
      return load(normalized.join('/'));
    });
    return module.exports;
  }
  return { inject: ['slots', 'configForms', 'remote', 'remote.session', 'remote.settings', 'remote.agentPresets'],
    apply(ctx) { return load('client/panel.mjs').mountPanel(hostRequire('react'), ctx, ${JSON.stringify(css)}); }
  };
} });
`);
