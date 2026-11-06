import busboy from 'busboy';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../domain/request.js';
import type { ResolvedProject, UploadedFile } from '../domain/types.js';
import { LIMITS } from '../shared/rules.js';
import { FileLibrary, type FileDraft } from '../storage/files.js';

/** Multipart and response streams stay outside task scheduling and file persistence. */
export class FileTransfer {
  private uploads = new Map<string, number>();
  constructor(private library: FileLibrary, private options: { maxFileBytes?: number; timeoutMs?: number } = {}) {}
  async upload(req: IncomingMessage, id: string, project: (signal: AbortSignal) => Promise<ResolvedProject>, stop: AbortSignal): Promise<UploadedFile> {
    const count = this.uploads.get(id) ?? 0;
    if (count >= LIMITS.uploadsPerProject || [...this.uploads.values()].reduce((a, b) => a + b, 0) >= LIMITS.uploads) throw new ApiError(429, 'UPLOAD_BUSY', 'At most 2 uploads per project and 8 overall');
    this.uploads.set(id, count + 1);
    try { return await this.receive(req, id, project, stop); }
    finally { this.uploads.set(id, this.uploads.get(id)! - 1); req.resume(); }
  }
  private async receive(req: IncomingMessage, id: string, project: (signal: AbortSignal) => Promise<ResolvedProject>, stop: AbortSignal): Promise<UploadedFile> {
    const limit = this.options.maxFileBytes ?? LIMITS.file;
    if (!/^multipart\/form-data(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected uncompressed multipart/form-data');
    if (Number(req.headers['content-length']) > limit + 65536) throw new ApiError(413, 'FILE_TOO_LARGE', 'Upload exceeds size limit');
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, preservePath: true, defParamCharset: 'utf8', limits: { files: 1, fields: 0, parts: 2, headerPairs: 32, fileSize: limit + 1 } }); }
    catch { throw new ApiError(400, 'INVALID_UPLOAD', 'Invalid multipart boundary'); }
    const controller = new AbortController();
    const signal = AbortSignal.any([stop, controller.signal]);
    let draft: FileDraft | undefined, writing: Promise<void> | undefined, size = 0;
    let reject!: (error: Error) => void;
    const parsed = new Promise<void>((resolve, fail) => { reject = fail; parser.once('finish', resolve); });
    const abort = (error: Error) => {
      if (controller.signal.aborted) return;
      controller.abort(error); req.unpipe(parser); req.resume(); reject(error);
      // Busboy cannot be destroyed inside its own synchronous file callback.
      queueMicrotask(() => parser.destroy());
    };
    const interrupted = () => abort(new ApiError(400, 'UPLOAD_ABORTED', 'Upload interrupted'));
    const meter = (chunk: Buffer) => { size += chunk.length; if (size > limit + 65536) abort(new ApiError(413, 'FILE_TOO_LARGE', 'Upload exceeds size limit')); };
    const timer = setTimeout(() => abort(new ApiError(408, 'UPLOAD_TIMEOUT', 'Upload timed out')), this.options.timeoutMs ?? LIMITS.transferTimeout);
    parser.on('error', () => abort(new ApiError(400, 'INVALID_UPLOAD', 'Malformed multipart body')));
    for (const event of ['fieldsLimit', 'filesLimit', 'partsLimit'] as const) parser.on(event, () => abort(new ApiError(400, 'INVALID_UPLOAD', 'Send exactly one file field named file')));
    parser.on('file', (name, stream, info) => {
      // Attach before awaiting filesystem staging: a malformed body can fail immediately.
      stream.once('error', () => abort(new ApiError(400, 'INVALID_UPLOAD', 'Malformed file stream')));
      if (controller.signal.aborted || name !== 'file' || !['7bit', '8bit', 'binary'].includes(info.encoding)) {
        stream.resume(); abort(new ApiError(400, 'INVALID_UPLOAD', 'Invalid file field')); return;
      }
      stream.on('limit', () => abort(new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds size limit')));
      writing = (async () => {
        const destination = await project(signal);
        signal.throwIfAborted();
        draft = await this.library.stage(id, destination, info.filename, info.mimeType);
        await draft.write(stream, signal, limit);
      })().catch(error => { abort(error instanceof ApiError ? error : new ApiError(503, 'FILE_STORAGE_ERROR', 'Could not save uploaded file')); });
    });
    stop.addEventListener('abort', interrupted, { once: true });
    req.once('error', interrupted); req.once('aborted', interrupted); req.on('data', meter);
    try {
      if (stop.aborted || req.aborted) interrupted(); else req.pipe(parser);
      await parsed; await writing;
      controller.signal.throwIfAborted();
      if (!draft) throw new ApiError(400, 'INVALID_UPLOAD', 'Exactly one file field is required');
      return await draft.commit(signal);
    } finally {
      clearTimeout(timer); stop.removeEventListener('abort', interrupted);
      req.off('error', interrupted); req.off('aborted', interrupted); req.off('data', meter);
      controller.abort(); req.unpipe(parser); parser.destroy();
      await writing; await draft?.dispose();
    }
  }
  async download(id: string, project: ResolvedProject, fileId: string, res: ServerResponse, stop: AbortSignal): Promise<void> {
    const disconnected = new AbortController(), onClose = () => disconnected.abort();
    res.once('close', onClose);
    const signal = AbortSignal.any([stop, disconnected.signal, AbortSignal.timeout(LIMITS.transferTimeout)]);
    try {
      const { file, handle } = await this.library.openDownload(id, project, fileId, signal);
      try {
        signal.throwIfAborted();
        const filename = encodeURIComponent(file.filename).replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size,
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`,
          'X-DSH-File-SHA256': file.sha256, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'none' });
        await pipeline(handle.createReadStream({ start: 0, autoClose: false }), res, { signal });
      } finally { await handle.close(); }
    } finally { res.off('close', onClose); }
  }
}
