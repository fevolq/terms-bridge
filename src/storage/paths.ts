import { createHash, randomInt } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../domain/request.js';

export const FILE_ROOT = '.terms-bridge';
export const pathIdentity = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return Boolean(child) && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}
export function generatedName(source = ''): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[randomInt(alphabet.length)];
  const extension = /^\.[a-z0-9]{1,16}$/i.test(extname(source)) ? extname(source).toLowerCase() : '';
  return `${Math.floor(Date.now() / 1000)}_${suffix}${extension}`;
}
/** Rebuild the saved workspace path without following a replacement symlink. */
export async function restoreWorkspaceDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (pathIdentity(await realpath(path)) !== pathIdentity(path)) throw new Error('Workspace directory changed to a symbolic link');
}
export async function directory(root: string, parts: string[], create = false): Promise<string> {
  let path = await realpath(root);
  for (const part of parts) {
    path = join(path, part);
    if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || pathIdentity(await realpath(path)) !== pathIdentity(path)) throw new ApiError(422, 'FILE_UNAVAILABLE', 'Managed directory is invalid');
  }
  return path;
}
export async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || pathIdentity(await realpath(path)) !== pathIdentity(path)) throw new ApiError(422, 'FILE_UNAVAILABLE', 'Managed file is invalid');
  return info;
}
export async function copyBytes(source: AsyncIterable<Uint8Array>, target: string, signal: AbortSignal, limit: number) {
  const digest = createHash('sha256');
  let size = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.length;
    if (size > limit) return done(new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds size limit'));
    digest.update(chunk);
    done(null, chunk);
  } });
  await pipeline(Readable.from(source), meter, createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }), { signal });
  return { size, sha256: digest.digest('hex') };
}
