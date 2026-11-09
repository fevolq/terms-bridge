import { z } from 'zod';
import { projectSchema } from '../projects/config.js';
import { uploadedFileSchema } from '../domain/file.js';
import { requestSchema, taskKey } from '../domain/request.js';
import { active, executing, queued } from '../domain/task.js';
import { LIMITS } from '../shared/rules.js';
import type { TaskMetadata, TaskRecord, TaskRequest, ResolvedProject, UploadedFile } from '../domain/types.js';
import type { BridgeDatabase } from './database.js';
import { ConversationStore } from './conversations.js';

const optionalTime = z.string().datetime().nullable();
const count = z.number().int().nonnegative();
export const recordSchema = z.object({
  request: requestSchema,
  project: projectSchema.extend({ name: z.string().min(1), workspace_path: z.string().min(1) }),
  files: z.array(uploadedFileSchema).max(LIMITS.files), output_files: z.array(uploadedFileSchema).max(LIMITS.files).optional(),
  status: z.enum(['queued', 'running', 'retrying', 'completed', 'failed']),
  execution: z.object({ attempts: count, attempt_id: z.string().nullable(), session_id: z.string().uuid(),
    next_retry_at: optionalTime, last_error: z.string().nullable() }).strict(),
  delivery: z.object({ status: z.enum(['not_ready', 'pending', 'retrying', 'delivered', 'failed']), attempts: count,
    next_retry_at: optionalTime, last_error: z.string().nullable(), in_flight: z.boolean() }).strict(),
  created_at: z.string().datetime(), completed_at: optionalTime, delivered_at: optionalTime,
  result: z.string().optional(), callback_body: z.string().nullable(),
}).strict().superRefine((task, context) => {
  const errors: string[] = [];
  const execution = task.execution, delivery = task.delivery;
  if (task.files.length !== task.request.files.length || task.files.some((file, index) => file.file_id !== task.request.files[index]?.file_id || file.project_id !== task.request.metadata.project_id)) errors.push('Input snapshot mismatch');
  for (const files of [task.files, task.output_files ?? []]) {
    if (files.reduce((sum, file) => sum + file.size, 0) > LIMITS.totalFiles || files.some(file => file.project_id !== task.request.metadata.project_id)) errors.push('File snapshot mismatch');
  }
  if (execution.attempts > task.project.max_execution_retries + 1 || delivery.attempts > LIMITS.callbackAttempts) errors.push('Attempt limit exceeded');
  if (task.status === 'queued' && execution.attempts !== 0) errors.push('Queued task already attempted');
  if (task.status === 'running' && !execution.attempt_id) errors.push('Missing attempt identity');
  if (task.status === 'failed' && execution.attempts !== task.project.max_execution_retries + 1) errors.push('Execution failed before exhaustion');
  if (delivery.status === 'failed' && delivery.attempts !== LIMITS.callbackAttempts) errors.push('Delivery failed before exhaustion');
  if (delivery.in_flight && !['pending', 'retrying'].includes(delivery.status)) errors.push('Invalid delivery state');
  if (delivery.status === 'delivered' && !task.delivered_at) errors.push('Missing delivery time');
  if (task.status === 'completed') {
    if (task.result === undefined || !task.completed_at || delivery.status === 'not_ready') errors.push('Incomplete result');
    if (task.callback_body !== JSON.stringify({ metadata: task.request.metadata, result: task.result, files: task.output_files ?? [] })) errors.push('Callback body mismatch');
  } else if (task.result !== undefined || task.callback_body !== null || task.completed_at !== null || delivery.status !== 'not_ready') errors.push('Result before completion');
  for (const message of errors) context.addIssue({ code: 'custom', message });
});
export class TaskStore {
  private admissions = new Map<string, Promise<unknown>>();
  readonly conversations: ConversationStore;
  constructor(private database: BridgeDatabase) { this.conversations = new ConversationStore(database.mappings); }
  async enqueue(key: string, request: TaskRequest, project: ResolvedProject, files: UploadedFile[], now: number): Promise<void> {
    const mapping = this.conversations.prepare(request.metadata, project);
    this.database.admitTask(key, queued(request, project, files, now, mapping), mapping);
  }
  get(key: string): TaskRecord | undefined { return this.database.tasks.get(key); }
  list(): [string, TaskRecord][] { return [...this.database.tasks.entries()]; }
  pending(): [string, TaskRecord][] {
    return [...this.database.tasks.pending()];
  }
  deleted(task: TaskRecord): boolean { return this.conversations.get(task.request.metadata)?.deleted ?? false; }
  active(task: TaskRecord): boolean { return !this.deleted(task) && active(task); }
  update(key: string, change: (task: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    // Recheck the shared marker when a queued write actually applies its transition.
    return this.database.tasks.update(key, current => this.deleted(current) ? current : change(current));
  }
  busy(metadata: TaskMetadata): boolean {
    if (this.conversations.get(metadata)?.deleted) return false;
    return this.database.tasks.busy(metadata);
  }
  async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const work = (this.admissions.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.admissions.set(key, work);
    try { return await work; }
    finally { if (this.admissions.get(key) === work) this.admissions.delete(key); }
  }
  assertProjects(projects: ReadonlyMap<string, { workspace_path?: string }>, pendingOnly = false): void {
    this.conversations.validate();
    const busy = new Set<string>();
    for (const [key, task] of pendingOnly ? this.pending() : this.list()) {
      const { project_id, conversation_id, chat_id } = task.request.metadata;
      if (key !== taskKey(project_id, conversation_id, chat_id)) throw new Error('Task record key mismatch');
      const conversation = this.conversations.get(task.request.metadata);
      if (!conversation || conversation.session_id !== task.execution.session_id || conversation.workspace_path !== task.project.workspace_path) throw new Error('Task conversation binding mismatch');
      if (conversation.deleted) continue;
      if (executing(task)) {
        if (busy.has(conversation.session_id)) throw new Error('Conversation has multiple unfinished tasks');
        busy.add(conversation.session_id);
      }
      if (!active(task)) continue;
      const project = projects.get(task.request.metadata.project_id);
      if (!project || executing(task) && project.workspace_path !== task.project.workspace_path) throw new Error('Active tasks require their configured project and original workspace');
    }
  }
}
