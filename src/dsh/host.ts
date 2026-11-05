import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationRecord, Project, Table, TaskRecord } from '../domain/types.js';

/** Only the public dsh surface used by the adapters; no bundled host implementation. */
export interface Workspace { id: string; path: string; title?: string; attachSession(id: string): Promise<void> }
export interface AttachmentRef { attachmentId: string; name?: string; [key: string]: unknown }
export interface ContentBlock { type: string; text?: string; attachment?: AttachmentRef }
export interface SessionEvent {
  type: string;
  data: { id?: string; turn?: number; reason?: { kind: string }; message?: { role: string; content: ContentBlock[] }; files?: { path: string }[];
    provider?: string; model?: string; reasoningEffort?: string };
}
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface Agent {
  id: string; status: 'idle' | 'running'; inbox: { nextTurn: readonly { id: string }[]; remove(id: string): boolean }; ctx: AgentScope;
  session: { snapshotEvents(): readonly SessionEvent[] };
  followup(message: { id: string; role: 'user'; source: { kind: 'user' }; content: ContentBlock[] }): void;
  whenIdle(): Promise<void>; cancel(reason: unknown, options?: { keepInbox: boolean }): void;
}
export interface AgentScope {
  tools: { get(name: string, agent?: Agent): unknown; restrict(filter: { deny: string[] }): () => void };
  on(event: 'system-prompt/assemble', handler: (assembly: unknown, context: { agent?: Agent }, next: () => Promise<{ variables: Record<string, unknown> }>) => Promise<unknown>, options?: { prepend: boolean }): () => void;
  on(event: 'session/event', handler: (session: Agent['session'], event: SessionEvent) => void): () => void;
  on(event: 'agent/inbox/claimed', handler: (payload: { agent: Agent; message: { id: string }; turn: number }) => void): () => void;
  on(event: 'agent/inbox/discarded', handler: (payload: { agent: Agent; message: { id: string } }) => void): () => void;
  on(event: 'agent/pre-step', handler: (payload: { agent: Agent; turn: number }, next: () => Promise<unknown>) => Promise<unknown>, options?: { prepend: boolean }): () => void;
}
export interface Host {
  readonly fiber?: unknown;
  workspaceRegistry: { list(): Workspace[]; create(path: string, title?: string): Promise<Workspace> };
  permissionPresets: { set(session: Agent['session'], mode: Project['permission_mode']): void };
  agents: { get(id: string): Agent | undefined };
  sessionController: {
    create(request: { sessionId: string; cwd: string; agentPreset?: string }): Promise<{ sessionId: string }>;
    resolveAgent(id: string): Promise<{ agent: Agent } | { error: Error }>;
  };
  sessionPersistence: { stat(id: string): Promise<unknown | undefined> };
  sessionProjections: { stateOf(session: Agent['session'], key: 'modelSelection'): { pending: ModelSelection | null } | undefined };
  attachments: {
    saveFileStream(input: { data: AsyncIterable<Uint8Array>; signal: AbortSignal; name: string }): Promise<AttachmentRef>;
    saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<AttachmentRef>;
    fileHostPath(ref: AttachmentRef): string | undefined; imageHostPath(ref: AttachmentRef): string | undefined;
  };
  storageDomain: { open(spec: object): Promise<{
    table(name: 'tasks'): Table<TaskRecord>; table(name: 'conversations'): Table<ConversationRecord>; close(): Promise<void>;
  }> };
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void };
  typert: { register(contribution: object): () => void };
  provide(name: string, service: object): () => void;
  effect(callback: () => (() => void | Promise<void>)): unknown;
  on?(event: string, callback: (this: unknown, ...args: unknown[]) => unknown): () => void;
  logger?(name: string): { info(message: string): void; error(message: string): void };
}
