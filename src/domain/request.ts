import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FILE_ID, LIMITS, PROJECT_ID, TASK_ID } from '../shared/rules.js';
import type { TaskRequest } from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const taskKey = (project: string, task: string): string => digest(JSON.stringify([project, task]));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const schema = z.object({
  metadata: z.object({ project_id: z.string().regex(PROJECT_ID), task_id: z.string().regex(TASK_ID) }).strict(),
  instruction: z.string().refine(value => Boolean(value.trim()) && [...value].length <= LIMITS.instruction),
  files: z.array(z.object({ file_id: z.string().regex(FILE_ID) }).strict()).max(LIMITS.files)
    .refine(files => new Set(files.map(file => file.file_id)).size === files.length),
}).strict();
export function validateRequest(value: unknown): TaskRequest {
  // Parse before serializing: circular/non-JSON values fail without traversing arbitrary objects.
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Expected metadata IDs, instruction and unique file references');
  if (bytes(parsed.data) > LIMITS.json) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request exceeds 1 MiB');
  return parsed.data;
}
export function fingerprint(request: TaskRequest): string {
  // Property order is irrelevant; attachment order and exact instruction text are part of identity.
  return digest(JSON.stringify([request.metadata.project_id, request.metadata.task_id, request.instruction, request.files.map(file => file.file_id)]));
}
