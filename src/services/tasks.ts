import { ApiError, bytes, conversationKey, resolveMetadata, taskKey, validateRequest } from '../domain/request.js';
import { beginDelivery, beginExecution, completed, deliveryFinished, executionFailed, publicTask, queued } from '../domain/task.js';
import { UnsettledExecutionError, type ResolvedProject, type Run, type TaskMetadata, type TaskRecord, type UploadedFile } from '../domain/types.js';
import { LIMITS } from '../shared/rules.js';
import type { TaskStore } from '../storage/tasks.js';

const readyAt = (task: TaskRecord): string => task.execution.next_retry_at ?? task.created_at;

interface TaskPorts {
  files: { resolve(projectId: string, project: ResolvedProject, refs: { file_id: string }[]): Promise<UploadedFile[]> };
  callback(task: TaskRecord, signal: AbortSignal): Promise<string | null>;
  now?: () => number; log?: (message: string) => void; sessionExists?: (id: string) => Promise<boolean>;
  sessionBusy?: (id: string) => boolean;
}
/** Application service: scheduling and durable commands, with all external work injected. */
export class TaskEngine {
  readonly stop = new AbortController();
  private ready = false;
  private broken = false;
  private timer?: ReturnType<typeof setInterval>;
  private running = new Map<string, Promise<void>>();
  private delivering = new Map<string, Promise<void>>();
  private requests = new Set<Promise<unknown>>();
  private admissions = new Set<Promise<unknown>>();
  private now: () => number;
  constructor(readonly store: TaskStore, readonly projects: Map<string, ResolvedProject>, private run: Run, private ports: TaskPorts) {
    this.now = ports.now ?? Date.now;
  }
  get available(): boolean { return this.ready && !this.broken && !this.stop.signal.aborted; }
  project(id: string): ResolvedProject {
    const project = this.projects.get(id);
    if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project is not configured');
    return project;
  }
  private assertReady(): void {
    if (!this.available) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Task bridge is stopping or not ready');
  }
  /** Admissions fence configuration changes; all operations are drained on shutdown. */
  async track<T>(operation: Promise<T>, admission = false): Promise<T> {
    this.requests.add(operation);
    if (admission) this.admissions.add(operation);
    try { return await operation; }
    finally { this.requests.delete(operation); this.admissions.delete(operation); }
  }
  async accept(input: unknown) {
    this.assertReady();
    const metadata = resolveMetadata(input), project = this.project(metadata.project_id);
    const key = taskKey(metadata.project_id, metadata.conversation_id, metadata.chat_id);
    return this.track(this.store.locked(conversationKey(metadata.project_id, metadata.conversation_id), async () => {
      this.assertReady();
      if (this.store.get(key)) throw new ApiError(409, 'CHAT_ALREADY_EXISTS', 'chat_id already exists in this conversation', metadata);
      if (await this.conversationDeleted(metadata)) throw new ApiError(404, 'SESSION_NOT_FOUND', '会话不存在', metadata);
      const existing = this.store.conversations.get(metadata);
      if (this.store.busy(metadata) || existing && this.ports.sessionBusy?.(existing.session_id)) throw new ApiError(409, 'CONVERSATION_BUSY', 'Conversation has an unfinished task', metadata);
      const request = validateRequest(input, metadata);
      const files = await this.ports.files.resolve(metadata.project_id, project, request.files);
      this.assertReady();
      // An empty binding after a failed task write does not reserve the conversation.
      const conversation = await this.store.conversations.ensure(metadata, project);
      await this.store.put(key, queued(request, project, files, this.now(), conversation));
      return { status: 202, body: { metadata, status: 'queued' },
        location: `/projects/${encodeURIComponent(metadata.project_id)}/conversations/${encodeURIComponent(metadata.conversation_id)}/chats/${encodeURIComponent(metadata.chat_id)}` };
    }), true);
  }
  async query(projectId: string, conversationId: string, chatId: string) {
    const key = taskKey(projectId, conversationId, chatId);
    const task = this.store.get(key);
    if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found');
    if (await this.conversationDeleted(task.request.metadata)) throw new ApiError(404, 'SESSION_NOT_FOUND', '会话不存在');
    return publicTask(this.store.get(key)!);
  }
  private async conversationDeleted(metadata: TaskMetadata): Promise<boolean> {
    const conversation = this.store.conversations.get(metadata);
    if (!conversation) return false;
    if (conversation.deleted) return true;
    if (conversation.created && this.ports.sessionExists && !await this.ports.sessionExists(conversation.session_id)) {
      await this.store.conversations.mark(metadata, 'deleted');
      return true;
    }
    return this.store.conversations.get(metadata)?.deleted ?? false;
  }
  async recover(): Promise<void> {
    for (const [, task] of this.store.list()) if (this.store.active(task)) await this.conversationDeleted(task.request.metadata);
    this.store.assertProjects(this.projects);
    for (const [key, task] of this.store.list()) {
      if (this.store.deleted(task)) continue;
      if (task.status === 'running') await this.store.update(key, value => executionFailed(value, task.execution.attempt_id!, 'EXECUTION_INTERRUPTED', this.now()));
      if (task.status === 'completed' && task.delivery.in_flight) await this.store.update(key, value => deliveryFinished(value, 'CALLBACK_INTERRUPTED', this.now()));
    }
    this.ready = true;
  }
  async reconfigure(projects: Map<string, ResolvedProject>, activate: () => void = () => {}): Promise<void> {
    while (this.admissions.size) await Promise.allSettled([...this.admissions]);
    this.assertReady();
    this.store.assertProjects(projects);
    activate();
    this.projects.clear();
    for (const [id, project] of projects) this.projects.set(id, project);
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
    this.timer.unref(); this.tick();
  }
  private launch(pool: Map<string, Promise<void>>, id: string, operation: () => Promise<void>): void {
    // Reserve synchronously, before asynchronous state checks or storage writes can yield.
    const work = Promise.resolve().then(operation).catch(() => {
      this.broken = true;
      this.ports.log?.('terms-bridge scheduler/storage error; scheduling paused until reload');
    }).finally(() => pool.delete(id));
    pool.set(id, work);
  }
  tick(): void {
    if (!this.available) return;
    const groups = new Map<string, [string, TaskRecord][]>();
    for (const entry of this.store.list()) {
      const id = entry[1].request.metadata.project_id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(entry);
    }
    for (const [id, project] of this.projects) {
      const tasks = groups.get(id) ?? [];
      let capacity = project.max_concurrency === 0 ? Infinity : project.max_concurrency - tasks.filter(([key]) => this.running.has(key)).length;
      const ready = tasks.filter(([key, task]) => !this.running.has(key) && !this.store.deleted(task) && ['queued', 'retrying'].includes(task.status) && Date.parse(readyAt(task)) <= this.now() && !this.ports.sessionBusy?.(task.execution.session_id));
      ready.sort((a, b) => readyAt(a[1]).localeCompare(readyAt(b[1])));
      for (const [key] of ready) {
        if (capacity-- <= 0) break;
        this.launch(this.running, key, () => this.execute(key));
      }
      if (this.delivering.has(id)) continue;
      const callbacks = tasks.filter(([, task]) => !this.store.deleted(task) && task.status === 'completed' && ['pending', 'retrying'].includes(task.delivery.status) && !task.delivery.in_flight && (!task.delivery.next_retry_at || Date.parse(task.delivery.next_retry_at) <= this.now()));
      callbacks.sort((a, b) => (a[1].delivery.next_retry_at ?? a[1].completed_at!).localeCompare(b[1].delivery.next_retry_at ?? b[1].completed_at!));
      if (callbacks[0]) this.launch(this.delivering, id, () => this.deliver(callbacks[0]![0]));
    }
  }
  private async execute(key: string): Promise<void> {
    if (await this.conversationDeleted(this.store.get(key)!.request.metadata)) return;
    const previous = this.store.get(key)!;
    if (!this.available || this.ports.sessionBusy?.(previous.execution.session_id)) return;
    const task = await this.store.update(key, beginExecution);
    if (this.store.deleted(task)) return;
    const timeout = AbortSignal.timeout(task.project.execution_timeout_seconds * 1000);
    const signal = AbortSignal.any([timeout, this.stop.signal]);
    try {
      const result = await this.run(task, signal, {
        created: this.store.conversations.get(task.request.metadata)!.created,
        ready: async () => {
          if (!this.store.conversations.get(task.request.metadata)!.created) await this.store.conversations.mark(task.request.metadata, 'created');
          signal.throwIfAborted();
        },
      });
      if (await this.conversationDeleted(task.request.metadata)) return;
      signal.throwIfAborted();
      if (!result || typeof result.result !== 'string') throw new Error('No final assistant response');
      if (bytes(result.result) > LIMITS.json) throw new Error('Final response exceeds 1 MiB');
      await this.store.update(key, current => {
        signal.throwIfAborted();
        return completed(current, task.execution.attempt_id!, result, this.now());
      });
    } catch (error) {
      if (await this.conversationDeleted(task.request.metadata)) return;
      // The host can start work after admission. No prompt was sent, so no retry was spent.
      if (error instanceof ApiError && error.code === 'CONVERSATION_BUSY') {
        await this.store.update(key, current => ({ ...current, status: previous.status, execution: previous.execution }));
        return;
      }
      if (error instanceof UnsettledExecutionError) throw error;
      let detail = error instanceof Error ? error.message : 'Unknown execution error';
      for (const secret of [task.project.request_token, ...Object.values(task.project.callback_headers)]) if (secret) detail = detail.split(secret).join('[redacted]');
      this.ports.log?.(`Execution ${task.execution.session_id}: ${detail.slice(0, 500)}`);
      const reason = this.stop.signal.aborted ? 'EXECUTION_INTERRUPTED' : timeout.aborted ? 'EXECUTION_TIMEOUT' : 'EXECUTION_ERROR';
      await this.store.update(key, current => executionFailed(current, task.execution.attempt_id!, reason, this.now()));
    }
  }
  private async deliver(key: string): Promise<void> {
    if (await this.conversationDeleted(this.store.get(key)!.request.metadata) || !this.available) return;
    const task = await this.store.update(key, beginDelivery);
    if (this.store.deleted(task) || task.delivery.status === 'failed') return;
    const error = await this.ports.callback(task, this.stop.signal);
    if (!await this.conversationDeleted(task.request.metadata)) await this.store.update(key, current => deliveryFinished(current, error, this.now()));
  }
  async settle(): Promise<void> { await Promise.all([...this.running.values(), ...this.delivering.values()]); }
  async close(): Promise<void> {
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    this.stop.abort();
    await Promise.allSettled([...this.requests, ...this.running.values(), ...this.delivering.values()]);
  }
}
