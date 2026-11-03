import { createReadStream } from 'node:fs';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UnsettledExecutionError, type Run, type TaskRecord, type UploadedFile } from '../domain/types.js';
import { LIMITS } from '../shared/rules.js';
import { FileLibrary } from '../storage/files.js';
import { generatedName, pathIdentity } from '../storage/paths.js';
import { prepareOutputDirectory, prepareTaskFiles } from '../storage/task-files.js';
import type { AgentHandle, ContentBlock, Host } from './host.js';
import { finalResponse, localResultPaths, presentedFiles, referencedPaths } from './results.js';

export function replaceFiles(instruction: string, files: { file_id: string; path: string }[]): string {
  const references = new Map(files.map(file => [file.file_id, file.path]));
  return instruction.replace(/(?<!\S)@(file_[a-f0-9]{32})(?!\S)/gu, (literal, id: string) => references.get(id) ?? literal);
}
async function collect(host: Host, library: FileLibrary, task: TaskRecord, blocks: ContentBlock[], presented: string[], signal: AbortSignal): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [], seen = new Set<string>();
  let total = 0;
  const publish = async (source: string, identity = source) => {
    if (seen.has(pathIdentity(identity))) return;
    if (files.length >= LIMITS.files) throw new Error('Too many result files');
    const file = await library.publish(task, source, signal);
    total += file.size;
    if (total > LIMITS.totalFiles) throw new Error('Result files exceed 200 MiB');
    files.push(file); seen.add(pathIdentity(identity));
  };
  for (const block of blocks) {
    signal.throwIfAborted();
    if (block.type === 'text') {
      for (const path of await referencedPaths(block.text ?? '', task.project.workspace_path)) await publish(path);
    } else if (block.attachment && ['image', 'file'].includes(block.type)) {
      const source = block.type === 'image' ? host.attachments.imageHostPath(block.attachment) : host.attachments.fileHostPath(block.attachment);
      if (!source) throw new Error('Final attachment has no local file');
      if (seen.has(pathIdentity(source))) continue;
      if ((await stat(source)).size > LIMITS.file) throw new Error('Result file exceeds 50 MiB');
      const directory = await prepareOutputDirectory(task);
      const staging = join(directory, generatedName(block.attachment.name ?? source));
      await copyFile(source, staging);
      await publish(staging, source);
    }
  }
  for (const path of await localResultPaths(presented, task.project.workspace_path)) {
    signal.throwIfAborted();
    await publish(path);
  }
  return files;
}
export function makeRunner(host: Host, library = new FileLibrary()): Run {
  return async (task, signal, sessionCreated = async () => {}) => {
    let handle: AgentHandle | undefined;
    const cancel = () => handle?.agent.cancel({ kind: 'hook', reason: 'terms-bridge stopped' });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const workspace = await host.workspaceRegistry.create(task.project.workspace_path, task.project.name);
      if (workspace.id !== task.project.workspace_id) throw new Error('Workspace binding changed');
      const inputs = await prepareTaskFiles(task, signal, library);
      const content: ContentBlock[] = [{ type: 'text', text: replaceFiles(task.request.instruction, inputs) }];
      for (const file of inputs) {
        signal.throwIfAborted();
        const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.media_type);
        const attachment = image
          ? await host.attachments.saveImage({ data: await readFile(file.path), mediaType: file.media_type, name: file.filename })
          : await host.attachments.saveFileStream({ data: createReadStream(file.path), name: file.filename, signal });
        content.push({ type: image ? 'image' : 'file', attachment });
      }
      const preset = await host.agentPresets.resolve(task.project.agent_preset);
      handle = await host.agents.create({ sessionId: task.execution.session_id!, signal,
        meta: { cwd: workspace.path, agentPreset: preset.id }, agentOptions: { provider: task.project.provider, model: task.project.model },
        async setup(scope, agent) {
          await host.agentPresets.mount(scope, preset.id);
          await scope.plugin({ name: 'terms-bridge-session', inject: ['tools'], apply(context) {
            if (context.tools.get('ask_user_question', agent)) context.tools.restrict({ deny: ['ask_user_question'] });
          } }).await();
        },
      });
      // Native creation chooses its own default first; override it before the user turn.
      host.permissionPresets.set(handle.agent.session, task.project.permission_mode);
      await workspace.attachSession(handle.agent.id);
      signal.throwIfAborted();
      handle.agent.followup({ id: task.execution.attempt_id!, role: 'user', source: { kind: 'user' }, content });
      await sessionCreated();
      await handle.agent.whenIdle();
      signal.throwIfAborted();
      const events = handle.agent.session.snapshotEvents(), blocks = finalResponse(events);
      const result = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
      // Freeze file contents while the host still owns the completed execution.
      return { result, files: await collect(host, library, task, blocks, presentedFiles(events), signal) };
    } finally {
      signal.removeEventListener('abort', cancel);
      try { await handle?.dispose(); }
      catch (cause) { throw new UnsettledExecutionError('Unable to dispose task session', { cause }); }
    }
  };
}
