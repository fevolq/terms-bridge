import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CHAT_ID, CONVERSATION_ID, FILE_ID, LIMITS, PROJECT_ID } from '../shared/rules.js';
import type { TaskMetadata, TaskRequest } from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly metadata?: TaskMetadata) { super(message); }
}
export const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const conversationKey = (project: string, conversation: string): string => digest(JSON.stringify([project, conversation]));
export const taskKey = (project: string, conversation: string, chat: string): string => digest(JSON.stringify([project, conversation, chat]));
export const metadataSchema = z.object({
  project_id: z.string().regex(PROJECT_ID), conversation_id: z.string().regex(CONVERSATION_ID), chat_id: z.string().regex(CHAT_ID),
}).strict();
const inputMetadata = metadataSchema.partial({ conversation_id: true, chat_id: true });
export const requestSchema = z.object({
  metadata: metadataSchema,
  instruction: z.string().refine(value => Boolean(value.trim()) && [...value].length <= LIMITS.instruction),
  files: z.array(z.object({ file_id: z.string().regex(FILE_ID) }).strict()).max(LIMITS.files)
    .refine(files => new Set(files.map(file => file.file_id)).size === files.length),
}).strict();
/** Only admission generates IDs. Stored records and outgoing envelopes require all three. */
export function resolveMetadata(value: unknown): TaskMetadata {
  const parsed = z.object({ metadata: inputMetadata }).safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Expected project_id and optional conversation_id and chat_id');
  const metadata = parsed.data.metadata;
  return { ...metadata, conversation_id: metadata.conversation_id ?? randomUUID(), chat_id: metadata.chat_id ?? randomUUID() };
}
export function validateRequest(value: unknown, metadata = resolveMetadata(value)): TaskRequest {
  const parsed = requestSchema.safeParse({ ...(value as object), metadata });
  if (!parsed.success) throw new ApiError(400, 'INVALID_REQUEST', 'Expected metadata, instruction and unique file references', metadata);
  if (bytes(parsed.data) > LIMITS.json) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request exceeds 1 MiB', metadata);
  return parsed.data;
}
