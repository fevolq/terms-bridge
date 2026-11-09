import { ApiError, bytes, resolveMetadata, taskKey, validateRequest } from '../domain/request.js';
import { beginDelivery, beginExecution, completed, executing, deliveryFinished, executionFailed, publicTask } from '../domain/task.js';
import { UnsettledExecutionError, type ProjectState, type ResolvedProject, type Run, type TaskMetadata, type TaskRecord, type UploadedFile } from '../domain/types.js';
import { LIMITS } from '../shared/rules.js';
import type { TaskStore } from '../storage/tasks.js';

const readyAt = (task: TaskRecord): string => task.execution.next_retry_at ?? task.created_at;

interface TaskPorts {
  files: { resolve(projectId: string, project: ResolvedProject, refs: { file_id: string }[]): Promise<UploadedFile[]> };
  callback(task: TaskRecord, signal: AbortSignal): Promise<string | null>;
  now?: () => number; log?: (message: string) => void; sessionExists?: (id: string) => Promise<boolean>;
  sessionBusy?: (id: string) => boolean;
  prepareProject?: (id: string, signal: AbortSignal, beforeRelocate: () => void) => Promise<ResolvedProject>;
}
/** Application service: scheduling and durable commands, with all external work injected. */
export class TaskEngine {
  readonly stop = new AbortController();
  private ready = false;
  private broken = false;
  private timer?: ReturnType<typeof setInterval>;
  private running = new Map<string, Promise<void>>();
  private delivering = new Map<string, Promise<void>>();
  private runningByProject = new Map<string, number>();
  private requests = new Set<Promise<unknown>>();
  private admissions = new Set<Promise<unknown>>();
  private uploads = new Map<string, number>();
  private now: () => number;
  constructor(readonly store: TaskStore, readonly projects: Map<string, ProjectState>, private run: Run, private ports: TaskPorts) {
    this.now = ports.now ?? Date.now;
  }
  get available(): boolean { return this.ready && !this.broken && !this.stop.signal.aborted; }
  project(id: string): ProjectState {
    const project = this.projects.get(id);
    if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project is not configured');
    return project;
  }
  private assertReady(): void {
    if (!this.available) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Task bridge is stopping or not ready');
  }
  private async prepareProject(id: string, signal: AbortSignal, metadata?: TaskMetadata): Promise<ResolvedProject> {
    const project = this.project(id), conversation = metadata && this.store.conversations.get(metadata);
    const changed = () => new ApiError(409, 'CONVERSATION_WORKSPACE_CHANGED', '会话绑定的工作区路径已变化', metadata);
    if (conversation && project.workspace_path !== conversation.workspace_path) throw changed();
    const beforeRelocate = () => {
      if (conversation) throw changed();
      if (this.uploads.get(id) || this.store.pending().some(([, task]) => task.request.metadata.project_id === id && !this.store.deleted(task) && executing(task))) {
        throw new ApiError(409, 'PROJECT_BUSY', '项目仍有未结束任务或文件上传，暂时无法切换工作区目录', metadata);
      }
    };
    if (this.ports.prepareProject) return this.ports.prepareProject(id, signal, beforeRelocate);
    if (!project.workspace_path) throw new ApiError(503, 'WORKSPACE_UNAVAILABLE', 'Project workspace is not initialized', metadata);
    return { ...project, workspace_path: project.workspace_path };
  }
  /** Admissions fence configuration changes; all operations are drained on shutdown. */
  async track<T>(operation: Promise<T>, admission = false): Promise<T> {
    this.requests.add(operation);
    if (admission) this.admissions.add(operation);
    try { return await operation; }
    finally { this.requests.delete(operation); this.admissions.delete(operation); }
  }
  /** Prepare under the project lock; stream concurrently while keeping that path bound. */
  async upload<T>(id: string, receive: (prepare: (signal: AbortSignal) => Promise<ResolvedProject>) => Promise<T>): Promise<T> {
    this.assertReady(); this.project(id);
    let prepared: ResolvedProject | undefined;
    const prepare = (signal: AbortSignal) => this.store.locked('project:' + id, async () => {
      this.assertReady(); signal.throwIfAborted();
      if (prepared) return prepared;
      const next = await this.prepareProject(id, signal);
      signal.throwIfAborted();
      prepared = next;
      this.uploads.set(id, (this.uploads.get(id) ?? 0) + 1);
      return prepared;
    });
    return this.track((async () => {
      try { return await receive(prepare); }
      finally {
        if (prepared) {
          const count = (this.uploads.get(id) ?? 1) - 1;
          if (count) this.uploads.set(id, count); else this.uploads.delete(id);
        }
      }
    })(), true);
  }
  async accept(input: unknown) {
    this.assertReady();
    const metadata = resolveMetadata(input);
    this.project(metadata.project_id);
    const key = taskKey(metadata.project_id, metadata.conversation_id, metadata.chat_id);
    // Directory recovery changes a project binding; serialize admissions for that project.
    return this.track(this.store.locked('project:' + metadata.project_id, async () => {
      this.assertReady();
      if (this.store.get(key)) throw new ApiError(409, 'CHAT_ALREADY_EXISTS', 'chat_id already exists in this conversation', metadata);
      if (await this.conversationDeleted(metadata)) throw new ApiError(404, 'SESSION_NOT_FOUND', '会话不存在', metadata);
      const existing = this.store.conversations.get(metadata);
      if (this.store.busy(metadata) || existing && this.ports.sessionBusy?.(existing.session_id)) throw new ApiError(409, 'CONVERSATION_BUSY', 'Conversation has an unfinished task', metadata);
      const request = validateRequest(input, metadata);
      const project = await this.prepareProject(metadata.project_id, this.stop.signal, metadata);
      const files = await this.ports.files.resolve(metadata.project_id, project, request.files);
      this.assertReady();
      // Persist the task and its conversation mapping in one transaction.
      await this.store.enqueue(key, request, project, files, this.now());
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
    for (const [, task] of this.store.pending()) if (this.store.active(task)) await this.conversationDeleted(task.request.metadata);
    this.store.assertProjects(this.projects);
    for (const [key, task] of this.store.pending()) {
      if (this.store.deleted(task)) continue;
      if (task.status === 'running') await this.store.update(key, value => executionFailed(value, task.execution.attempt_id!, 'EXECUTION_INTERRUPTED', this.now()));
      if (task.status === 'completed' && task.delivery.in_flight) await this.store.update(key, value => deliveryFinished(value, 'CALLBACK_INTERRUPTED', this.now()));
    }
    this.ready = true;
  }
  async reconfigure(source: Map<string, ProjectState> | (() => Promise<Map<string, ProjectState>>), activate: (projects: Map<string, ProjectState>) => void | Promise<void> = () => {}): Promise<void> {
    while (this.admissions.size) await Promise.allSettled([...this.admissions]);
    this.assertReady();
    // Drain admissions first; keep the old registry until persistence and route activation succeed.
    this.ready = false;
    try {
      const projects = typeof source === 'function' ? await source() : source;
      this.store.assertProjects(projects, true);
      await activate(projects);
      this.projects.clear();
      for (const [id, project] of projects) this.projects.set(id, project);
    } finally { this.ready = !this.stop.signal.aborted; }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
    this.timer.unref(); this.tick();
  }
  private failScheduling(): void {
    if (this.broken) return;
    this.broken = true;
    this.ports.log?.('terms-bridge scheduler/storage error; scheduling paused until reload');
  }
  private launch(pool: Map<string, Promise<void>>, id: string, operation: () => Promise<void>, finished?: () => void): void {
    // Reserve synchronously, before asynchronous state checks or storage writes can yield.
    const work = Promise.resolve().then(operation).catch(() => this.failScheduling())
      .finally(() => { pool.delete(id); finished?.(); });
    pool.set(id, work);
  }
  tick(): void {
    if (!this.available) return;
    try {
      const groups = new Map<string, [string, TaskRecord][]>();
      for (const entry of this.store.pending()) {
        const id = entry[1].request.metadata.project_id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id)!.push(entry);
      }
      for (const [id, project] of this.projects) {
        const tasks = groups.get(id) ?? [];
        let capacity = project.max_concurrency === 0 ? Infinity : project.max_concurrency - (this.runningByProject.get(id) ?? 0);
        const ready = tasks.filter(([key, task]) => !this.running.has(key) && !this.store.deleted(task) && ['queued', 'retrying'].includes(task.status) && Date.parse(readyAt(task)) <= this.now() && !this.ports.sessionBusy?.(task.execution.session_id));
        ready.sort((a, b) => readyAt(a[1]).localeCompare(readyAt(b[1])));
        for (const [key] of ready) {
          if (capacity-- <= 0) break;
          // A deleted session leaves the query immediately, but its execution may still be draining.
          this.runningByProject.set(id, (this.runningByProject.get(id) ?? 0) + 1);
          this.launch(this.running, key, () => this.execute(key), () => {
            const count = this.runningByProject.get(id)! - 1;
            if (count) this.runningByProject.set(id, count); else this.runningByProject.delete(id);
          });
        }
        if (this.delivering.has(id)) continue;
        const callbacks = tasks.filter(([, task]) => !this.store.deleted(task) && task.status === 'completed' && ['pending', 'retrying'].includes(task.delivery.status) && !task.delivery.in_flight && (!task.delivery.next_retry_at || Date.parse(task.delivery.next_retry_at) <= this.now()));
        callbacks.sort((a, b) => (a[1].delivery.next_retry_at ?? a[1].completed_at!).localeCompare(b[1].delivery.next_retry_at ?? b[1].completed_at!));
        if (callbacks[0]) this.launch(this.delivering, id, () => this.deliver(callbacks[0]![0]));
      }
    } catch { this.failScheduling(); }
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
