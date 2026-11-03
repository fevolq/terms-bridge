import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ApiError } from '../domain/request.js';
import { uploadedFileSchema } from '../domain/file.js';
import { FILE_ID, LIMITS } from '../shared/rules.js';
import type { ResolvedProject, TaskRecord, UploadedFile } from '../domain/types.js';
import { copyBytes, directory, FILE_ROOT, generatedName, inside, regularFile } from './paths.js';

/** A draft is visible by ID only after commit; callers always dispose it in finally. */
export class FileDraft {
  private written = false;
  constructor(readonly file: UploadedFile, private path: string) {}
  async write(source: AsyncIterable<Uint8Array>, signal: AbortSignal, limit = LIMITS.file): Promise<void> {
    Object.assign(this.file, await copyBytes(source, join(this.path, this.file.filename), signal, limit));
    this.written = true;
  }
  async commit(signal: AbortSignal): Promise<UploadedFile> {
    if (!this.written) throw new Error('File draft has no completed content');
    uploadedFileSchema.parse(this.file);
    await writeFile(join(this.path, 'metadata.json'), JSON.stringify(this.file), { flag: 'wx', mode: 0o600, flush: true });
    signal.throwIfAborted();
    await rename(this.path, join(dirname(this.path), this.file.file_id));
    return this.file;
  }
  async dispose(): Promise<void> { await rm(this.path, { recursive: true, force: true }); }
}
export class FileLibrary {
  async stage(projectId: string, project: ResolvedProject, filename: string, mediaType: string): Promise<FileDraft> {
    const file: UploadedFile = { file_id: 'file_' + randomUUID().replaceAll('-', ''), project_id: projectId,
      filename: generatedName(filename), media_type: mediaType.slice(0, 200), size: 0, sha256: '', created_at: new Date().toISOString() };
    const path = await directory(project.workspace_path, [FILE_ROOT, 'files', '.incoming-' + file.file_id], true);
    return new FileDraft(file, path);
  }
  async resolve(projectId: string, project: ResolvedProject, refs: { file_id: string }[]): Promise<UploadedFile[]> {
    const result: UploadedFile[] = [];
    for (const { file_id } of refs) {
      if (!FILE_ID.test(file_id)) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid file_id');
      try {
        const folder = await directory(project.workspace_path, [FILE_ROOT, 'files', file_id]);
        const metadata = join(folder, 'metadata.json');
        if ((await regularFile(metadata)).size > 4096) throw new Error('Invalid metadata size');
        const file = uploadedFileSchema.parse(JSON.parse(await readFile(metadata, 'utf8')));
        if (file.project_id !== projectId || file.file_id !== file_id) throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found in this project');
        if ((await regularFile(join(folder, file.filename))).size !== file.size) throw new ApiError(422, 'FILE_UNAVAILABLE', 'File size changed');
        result.push(file);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found in this project');
        throw new ApiError(422, 'FILE_UNAVAILABLE', 'File metadata is invalid');
      }
    }
    if (result.reduce((size, file) => size + file.size, 0) > LIMITS.totalFiles) throw new ApiError(413, 'TASK_FILES_TOO_LARGE', 'Task files exceed 200 MiB');
    return result;
  }
  async openDownload(projectId: string, project: ResolvedProject, fileId: string, signal: AbortSignal) {
    const [file] = await this.resolve(projectId, project, [{ file_id: fileId }]);
    const path = join(await directory(project.workspace_path, [FILE_ROOT, 'files', fileId]), file!.filename);
    const before = await regularFile(path), handle = await open(path, 'r');
    try {
      const current = await handle.stat();
      if (current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 || !current.isFile()) throw new ApiError(422, 'FILE_UNAVAILABLE', 'File changed while opening');
      const digest = createHash('sha256');
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        size += chunk.length;
        if (size > file!.size) throw new ApiError(422, 'FILE_UNAVAILABLE', 'File size changed');
        digest.update(chunk);
      }
      if (size !== file!.size || digest.digest('hex') !== file!.sha256) throw new ApiError(422, 'FILE_UNAVAILABLE', 'File checksum changed');
      return { file: file!, handle };
    } catch (error) { await handle.close(); throw error; }
  }
  async publish(task: TaskRecord, requested: string, signal: AbortSignal): Promise<UploadedFile> {
    const root = task.project.workspace_path, source = resolve(root, requested);
    if (!inside(root, source)) throw new ApiError(400, 'INVALID_FILE_PATH', 'File must be inside the project workspace');
    await directory(root, relative(root, source).split(sep).slice(0, -1));
    const before = await regularFile(source);
    if (before.size > LIMITS.file) throw new ApiError(413, 'FILE_TOO_LARGE', 'Result file exceeds 50 MiB');
    const handle = await open(source, 'r');
    let draft: FileDraft | undefined;
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || !opened.isFile()) throw new ApiError(422, 'FILE_UNAVAILABLE', 'File changed while opening');
      draft = await this.stage(task.request.metadata.project_id, task.project, source, 'application/octet-stream');
      await draft.write(handle.createReadStream({ autoClose: false }), signal);
      const after = await handle.stat();
      if (draft.file.size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new ApiError(422, 'FILE_UNAVAILABLE', 'Result file changed while publishing');
      return await draft.commit(signal);
    } finally { await handle.close(); await draft?.dispose(); }
  }
}
