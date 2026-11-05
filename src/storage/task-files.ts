import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { taskKey } from '../domain/request.js';
import type { TaskRecord, UploadedFile } from '../domain/types.js';
import { FileLibrary } from './files.js';
import { copyBytes, directory, FILE_ROOT } from './paths.js';

function attemptPath(task: TaskRecord): string[] {
  const { project_id, conversation_id, chat_id } = task.request.metadata;
  return [FILE_ROOT, 'tasks', taskKey(project_id, conversation_id, chat_id), task.execution.attempt_id!];
}
export function prepareOutputDirectory(task: TaskRecord): Promise<string> {
  return directory(task.project.workspace_path, [...attemptPath(task), 'outputs'], true);
}
/** Each execution owns fresh input copies; source IDs remain reusable after edits or retries. */
export async function prepareTaskFiles(task: TaskRecord, signal: AbortSignal, library = new FileLibrary()) {
  const result: (UploadedFile & { path: string })[] = [];
  for (const file of task.files) {
    const folder = await directory(task.project.workspace_path, [...attemptPath(task), 'inputs', file.file_id], true);
    const path = join(folder, file.filename);
    const { handle } = await library.openDownload(file.project_id, task.project, file.file_id, signal);
    try {
      const saved = await copyBytes(handle.createReadStream({ start: 0, autoClose: false }), path, signal, file.size);
      if (saved.size !== file.size || saved.sha256 !== file.sha256) throw new Error('Uploaded input file checksum changed');
      result.push({ ...file, path });
    } catch (error) { await rm(path, { force: true }); throw error; }
    finally { await handle.close(); }
  }
  return result;
}
