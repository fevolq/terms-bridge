import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../domain/request.js';
import { CHAT_ID, CONVERSATION_ID, FILE_ID, LIMITS, PROJECT_ID } from '../shared/rules.js';
import type { TaskEngine } from '../services/tasks.js';
import type { FileTransfer } from './files.js';

export function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected uncompressed UTF-8 JSON');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const clean = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed); };
    const fail = (error: Error) => { clean(); req.resume(); reject(error); };
    const failed = () => fail(new ApiError(400, 'INVALID_REQUEST', 'Request interrupted'));
    const timer = setTimeout(() => fail(new ApiError(400, 'INVALID_REQUEST', 'Request timed out')), 15000);
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMITS.json) fail(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request exceeds 1 MiB'));
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new ApiError(400, 'INVALID_REQUEST', 'Invalid UTF-8 JSON')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed);
  });
}
function identity(raw: string, pattern: RegExp): string {
  let value: string;
  try { value = decodeURIComponent(raw); } catch { throw new ApiError(400, 'INVALID_REQUEST', 'Invalid URL encoding'); }
  if (!pattern.test(value)) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid resource identity');
  return value;
}
function method(req: IncomingMessage, res: ServerResponse, expected: string): void {
  if (req.method === expected) return;
  res.setHeader('Allow', expected);
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Use ${expected}`);
}
export function handler(tasks: TaskEngine, prefix: string, files: FileTransfer, before?: (method: string) => Promise<void>) {
  const authorize = (req: IncomingMessage, id: string) => {
    const project = tasks.project(id);
    if (project.request_token) {
      const expected = Buffer.from('Bearer ' + project.request_token), actual = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid project token');
    }
    return project;
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await before?.(req.method ?? '');
      if (!tasks.available) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Task bridge is not ready');
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === prefix + '/tasks') {
        method(req, res, 'POST');
        const body = await jsonBody(req) as { metadata?: { project_id?: unknown } } | null;
        const id = body?.metadata?.project_id;
        if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid project_id');
        authorize(req, id);
        const result = await tasks.accept(body);
        res.setHeader('Location', prefix + result.location);
        respond(res, result.status, result.body); return;
      }
      const path = pathname.startsWith(prefix + '/') ? pathname.slice(prefix.length) : '';
      const chat = /^\/projects\/([^/]+)\/conversations\/([^/]+)\/chats\/([^/]+)$/.exec(path);
      if (chat) {
        method(req, res, 'GET');
        const id = identity(chat[1]!, PROJECT_ID); authorize(req, id);
        respond(res, 200, await tasks.track(tasks.query(id, identity(chat[2]!, CONVERSATION_ID), identity(chat[3]!, CHAT_ID))));
        return;
      }
      const route = /^\/projects\/([^/]+)\/files(?:\/([^/]+))?$/.exec(path);
      if (!route) throw new ApiError(404, 'NOT_FOUND', 'Unknown task bridge route');
      const [, rawId, rawKey] = route;
      method(req, res, rawKey ? 'GET' : 'POST');
      const id = identity(rawId!, PROJECT_ID), project = authorize(req, id);
      if (rawKey) {
        if (!project.workspace_path) throw new ApiError(404, 'FILE_NOT_FOUND', 'Project workspace has not been initialized');
        await tasks.track(files.download(id, { ...project, workspace_path: project.workspace_path }, identity(rawKey, FILE_ID), res, tasks.stop.signal));
      } else {
        respond(res, 201, await tasks.upload(id, prepare => files.upload(req, id, prepare, tasks.stop.signal)));
      }
    } catch (error) {
      req.resume();
      if (res.headersSent) { res.destroy(); return; }
      const failure = error instanceof ApiError ? error : new ApiError(503, 'SERVICE_UNAVAILABLE', 'Task service unavailable');
      respond(res, failure.status, { ...(failure.metadata ? { metadata: failure.metadata } : {}), error: { code: failure.code, message: failure.message } });
    }
  };
}
