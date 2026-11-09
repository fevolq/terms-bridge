import { createReadStream } from 'node:fs';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UnsettledExecutionError, type Run, type TaskRecord, type UploadedFile } from '../domain/types.js';
import { LIMITS } from '../shared/rules.js';
import type { FileLibrary } from '../storage/files.js';
import { generatedName, pathIdentity } from '../storage/paths.js';
import { prepareOutputDirectory, prepareTaskFiles } from '../storage/task-files.js';
import type { ContentBlock, Host } from './host.js';
import { finalResponse, localResultPaths, presentedFiles, referencedPaths } from './results.js';
import { openSession } from './sessions.js';
import { sendTask } from './turn.js';

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
export function makeRunner(host: Host, library: FileLibrary): Run {
  return async (task, signal, session) => {
    let turn: ReturnType<typeof sendTask> | undefined;
    try {
      signal.throwIfAborted();
      const workspace = host.workspaceRegistry.list().find(value => pathIdentity(value.path) === pathIdentity(task.project.workspace_path));
      if (!workspace) throw new Error('Task workspace is no longer registered');
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
      const agent = await openSession(host, task, signal, session.created);
      await session.ready();
      await workspace.attachSession(agent.id);
      signal.throwIfAborted();
      turn = sendTask(host, agent, task, content, signal);
      const events = await turn.completed;
      signal.throwIfAborted();
      const blocks = finalResponse(events);
      const result = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
      // Subsequent turns are held at the native execution boundary until close().
      return { result, files: await collect(host, library, task, blocks, presentedFiles(events), signal) };
    } finally {
      try { await turn?.close(); }
      catch (cause) { throw new UnsettledExecutionError('Unable to settle task turn', { cause }); }
    }
  };
}
