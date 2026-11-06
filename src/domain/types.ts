import type { PERMISSIONS } from '../shared/rules.js';

export interface TaskMetadata { project_id: string; conversation_id: string; chat_id: string }
export interface TaskRequest {
  metadata: TaskMetadata;
  instruction: string;
  files: { file_id: string }[];
}
export interface UploadedFile {
  file_id: string; project_id: string; filename: string; media_type: string;
  size: number; sha256: string; created_at: string;
}
export interface Project {
  name: string; created_at?: string; workspace_path?: string; provider: string; model: string;
  agent_preset?: string; permission_mode: typeof PERMISSIONS[number]; max_concurrency: number;
  callback_url: string; request_token?: string; callback_headers: Record<string, string>;
  max_execution_retries: number; execution_timeout_seconds: number;
  retry_interval_seconds: number; callback_timeout_seconds: number;
}
export interface PluginConfig { api_prefix: string; projects: Record<string, Project> }
/** The configured path remains stable even if recovery must bind a replacement. */
export interface WorkspaceBinding { workspace_path: string; configured_path?: string }
/** workspace_path is a resolved binding; configured_path retains the manual setting until first use. */
export interface ProjectState extends Project { configured_path?: string }
export interface ResolvedProject extends ProjectState { workspace_path: string }
export type TaskStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed';
export type DeliveryStatus = 'not_ready' | 'pending' | 'retrying' | 'delivered' | 'failed';
export interface ConversationRecord {
  project_id: string; conversation_id: string; session_id: string;
  workspace_path: string; created: boolean; deleted: boolean;
}
export interface TaskRecord {
  request: TaskRequest; project: ResolvedProject; status: TaskStatus;
  files: UploadedFile[]; output_files?: UploadedFile[];
  execution: {
    attempts: number; attempt_id: string | null; session_id: string;
    next_retry_at: string | null; last_error: string | null;
  };
  delivery: { status: DeliveryStatus; attempts: number; next_retry_at: string | null; last_error: string | null; in_flight: boolean };
  created_at: string; completed_at: string | null; delivered_at: string | null;
  result?: string; callback_body: string | null;
}
export interface Table<T> {
  get(key: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(key: string, value: T): Promise<void>;
  update(key: string, change: (value: T) => T): Promise<T>;
}
export interface Result { result: string; files: UploadedFile[] }
/** Runtime snapshot; the conversation table alone owns the durable creation marker. */
export interface SessionLifecycle { created: boolean; ready(): Promise<void> }
export type Run = (task: TaskRecord, signal: AbortSignal, session: SessionLifecycle) => Promise<Result>;
/** Releasing a concurrency slot is unsafe until this task's turn and cleanup settle. */
export class UnsettledExecutionError extends Error {}
