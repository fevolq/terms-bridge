import { randomUUID } from 'node:crypto';
import { LIMITS } from '../shared/rules.js';
import { fingerprint } from './request.js';
import type { ResolvedProject, Result, TaskRecord, TaskRequest, UploadedFile } from './types.js';

const at = (time: number): string => new Date(time).toISOString();
export const active = (task: TaskRecord): boolean => !task.session_deleted &&
  (['queued', 'running', 'retrying'].includes(task.status) ||
    task.status === 'completed' && ['pending', 'retrying'].includes(task.delivery.status));
export function queued(request: TaskRequest, project: ResolvedProject, files: UploadedFile[], now: number): TaskRecord {
  return {
    request: structuredClone(request), project: structuredClone(project), files, fingerprint: fingerprint(request), status: 'queued',
    execution: { attempts: 0, attempt_id: null, session_id: null, sessions: [], session_created: false, next_retry_at: null, last_error: null },
    delivery: { status: 'not_ready', attempts: 0, next_retry_at: null, last_error: null, in_flight: false },
    ready_at: at(now), created_at: at(now), completed_at: null, delivered_at: null, callback_body: null,
  };
}
/** State transitions return detached values; persistence and side effects belong to the service. */
export function beginExecution(task: TaskRecord): TaskRecord {
  if (task.session_deleted) return task;
  if (!['queued', 'retrying'].includes(task.status)) throw new Error('Task is not runnable');
  if (task.execution.attempts > task.project.max_execution_retries) throw new Error('Execution budget exhausted');
  const session = randomUUID();
  return { ...task, status: 'running', execution: {
    attempts: task.execution.attempts + 1, attempt_id: randomUUID(), session_id: session,
    sessions: [...task.execution.sessions, session], session_created: false, next_retry_at: null, last_error: null,
  } };
}
export function executionFailed(task: TaskRecord, attempt: string, error: string, now: number): TaskRecord {
  if (task.session_deleted || task.status !== 'running' || task.execution.attempt_id !== attempt) return task;
  const retry = task.execution.attempts <= task.project.max_execution_retries;
  const next = retry ? at(now + task.project.retry_interval_seconds * 1000) : null;
  return { ...task, status: retry ? 'retrying' : 'failed', ready_at: next ?? task.ready_at,
    execution: { ...task.execution, attempt_id: null, next_retry_at: next, last_error: error } };
}
export function completed(task: TaskRecord, attempt: string, result: Result, now: number): TaskRecord {
  if (task.session_deleted) return task;
  if (task.status !== 'running' || task.execution.attempt_id !== attempt) throw new Error('Attempt expired');
  return { ...task, status: 'completed', result: result.result, output_files: result.files, completed_at: at(now),
    callback_body: JSON.stringify({ metadata: task.request.metadata, result: result.result, files: result.files }),
    delivery: { ...task.delivery, status: 'pending' },
    execution: { ...task.execution, last_error: null, next_retry_at: null } };
}
export function beginDelivery(task: TaskRecord): TaskRecord {
  if (task.session_deleted) return task;
  if (task.delivery.attempts >= LIMITS.callbackAttempts) return { ...task, delivery: { ...task.delivery, status: 'failed', in_flight: false, next_retry_at: null } };
  return { ...task, delivery: { ...task.delivery, attempts: task.delivery.attempts + 1, in_flight: true, next_retry_at: null } };
}
export function deliveryFinished(task: TaskRecord, error: string | null, now: number): TaskRecord {
  if (task.session_deleted) return task;
  const retry = error !== null && task.delivery.attempts < LIMITS.callbackAttempts;
  return { ...task, delivered_at: error === null ? at(now) : task.delivered_at,
    delivery: { ...task.delivery, status: error === null ? 'delivered' : retry ? 'retrying' : 'failed',
      next_retry_at: retry ? at(now + LIMITS.callbackInterval) : null, last_error: error, in_flight: false } };
}
export function publicTask(task: TaskRecord) {
  const { attempts, session_id, next_retry_at, last_error } = task.execution;
  const { in_flight, ...delivery } = task.delivery;
  return { metadata: task.request.metadata, status: task.status,
    execution: { attempts, session_id, next_retry_at, last_error }, delivery,
    created_at: task.created_at, completed_at: task.completed_at, delivered_at: task.delivered_at,
    ...(task.status === 'completed' ? { result: task.result, files: task.output_files ?? [] } : {}) };
}
