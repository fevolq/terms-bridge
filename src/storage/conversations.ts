import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conversationKey } from '../domain/request.js';
import type { ConversationRecord, ResolvedProject, Table, TaskMetadata } from '../domain/types.js';
import { CONVERSATION_ID, PROJECT_ID } from '../shared/rules.js';

export const conversationSchema = z.object({
  project_id: z.string().regex(PROJECT_ID), conversation_id: z.string().regex(CONVERSATION_ID),
  session_id: z.string().uuid(), workspace_id: z.string().optional(), workspace_path: z.string().min(1),
  created: z.boolean(), deleted: z.boolean(),
}).strict().transform(({ workspace_id, ...record }) => record);

/** Durable identity only; dsh owns history. Admission holds the project lock. */
export class ConversationStore {
  constructor(private table: Table<ConversationRecord>) {}
  get(metadata: Pick<TaskMetadata, 'project_id' | 'conversation_id'>): ConversationRecord | undefined {
    return this.table.get(conversationKey(metadata.project_id, metadata.conversation_id));
  }
  async ensure(metadata: TaskMetadata, project: ResolvedProject): Promise<ConversationRecord> {
    const existing = this.get(metadata);
    if (existing) {
      // Removing a DSH registration changes its ID, not the conversation's directory.
      if (existing.workspace_path !== project.workspace_path) {
        throw new ApiError(409, 'CONVERSATION_WORKSPACE_CHANGED', 'Conversation belongs to its original workspace', metadata);
      }
      return existing;
    }
    const conversation: ConversationRecord = { project_id: metadata.project_id, conversation_id: metadata.conversation_id,
      session_id: randomUUID(), workspace_path: project.workspace_path, created: false, deleted: false };
    await this.table.put(conversationKey(metadata.project_id, metadata.conversation_id), conversation);
    return conversation;
  }
  mark(metadata: TaskMetadata, field: 'created' | 'deleted'): Promise<ConversationRecord> {
    return this.table.update(conversationKey(metadata.project_id, metadata.conversation_id), current => ({ ...current, [field]: true }));
  }
  validate(): void {
    const sessions = new Set<string>();
    for (const [key, value] of this.table.entries()) {
      if (key !== conversationKey(value.project_id, value.conversation_id) || sessions.has(value.session_id)) throw new Error('Invalid conversation binding');
      sessions.add(value.session_id);
    }
  }
}
