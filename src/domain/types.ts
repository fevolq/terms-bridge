import type { PERMISSIONS } from '../shared/rules.js';

export interface TaskRequest {
  metadata: { project_id: string; task_id: string };
  instruction: string;
  files: { file_id: string }[];
}
export interface UploadedFile {
  file_id: string; project_id: string; filename: string; media_type: string;
  size: number; sha256: string; created_at: string;
}
export interface Project {
  name: string; workspace_path?: string; provider: string; model: string;
  agent_preset?: string; permission_mode: typeof PERMISSIONS[number]; max_concurrency: number;
  callback_url: string; request_token?: string; callback_headers: Record<string, string>;
  max_execution_retries: number; execution_timeout_seconds: number;
  retry_interval_seconds: number; callback_timeout_seconds: number;
}
export interface PluginConfig { api_prefix: string; projects: Record<string, Project> }
export interface ResolvedProject extends Project { workspace_id: string; workspace_path: string }
export type TaskStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed';
export type DeliveryStatus = 'not_ready' | 'pending' | 'retrying' | 'delivered' | 'failed';
export interface TaskRecord {
  request: TaskRequest; fingerprint: string; project: ResolvedProject; status: TaskStatus;
  files: UploadedFile[]; output_files?: UploadedFile[]; session_deleted?: boolean;
  execution: {
    attempts: number; attempt_id: string | null; session_id: string | null;
    sessions: string[]; session_created: boolean; next_retry_at: string | null; last_error: string | null;
  };
  delivery: { status: DeliveryStatus; attempts: number; next_retry_at: string | null; last_error: string | null; in_flight: boolean };
  ready_at: string; created_at: string; completed_at: string | null; delivered_at: string | null;
  result?: string; callback_body: string | null;
}
export interface Table<T> {
  get(key: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(key: string, value: T): Promise<void>;
  update(key: string, change: (value: T) => T): Promise<T>;
}
export interface Result { result: string; files: UploadedFile[] }
export type Run = (task: TaskRecord, signal: AbortSignal, sessionCreated: () => Promise<void>) => Promise<Result>;
/** Releasing a concurrency slot is unsafe until the host confirms runner disposal. */
export class UnsettledExecutionError extends Error {}
