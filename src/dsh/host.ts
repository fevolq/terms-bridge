import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Project, Table, TaskRecord } from '../domain/types.js';

/** Only the public dsh surface used by the adapters; no bundled host implementation. */
export interface Workspace { id: string; path: string; title?: string; attachSession(id: string): Promise<void> }
export interface AttachmentRef { attachmentId: string; name?: string; [key: string]: unknown }
export interface ContentBlock { type: string; text?: string; attachment?: AttachmentRef }
export interface SessionEvent {
  type: string;
  data: { turn?: number; reason?: { kind: string }; message?: { role: string; content: ContentBlock[] }; files?: { path: string }[] };
}
export interface Agent {
  id: string; session: { snapshotEvents(): readonly SessionEvent[] };
  followup(message: { id: string; role: 'user'; source: { kind: 'user' }; content: ContentBlock[] }): void;
  whenIdle(): Promise<void>; cancel(reason: unknown): void;
}
export interface AgentHandle { agent: Agent; dispose(): Promise<void> }
export interface AgentScope {
  plugin(plugin: { name: string; inject: string[]; apply(scope: AgentScope): void }): { await(): Promise<unknown> };
  tools: { get(name: string, agent?: Agent): unknown; restrict(filter: { deny: string[] }): unknown };
}
export interface Host {
  readonly fiber?: unknown;
  workspaceRegistry: { list(): Workspace[]; create(path: string, title?: string): Promise<Workspace> };
  agentPresets: { resolve(id?: string): Promise<{ id: string }>; mount(scope: AgentScope, id: string): Promise<unknown> };
  permissionPresets: { set(session: Agent['session'], mode: Project['permission_mode']): void };
  agents: { create(options: {
    sessionId: string; meta: { cwd: string; agentPreset: string }; agentOptions: { provider: string; model: string };
    signal: AbortSignal; setup(scope: AgentScope, agent: Agent): Promise<void>;
  }): Promise<AgentHandle> };
  sessionPersistence: { stat(id: string): Promise<unknown | undefined> };
  attachments: {
    saveFileStream(input: { data: AsyncIterable<Uint8Array>; signal: AbortSignal; name: string }): Promise<AttachmentRef>;
    saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<AttachmentRef>;
    fileHostPath(ref: AttachmentRef): string | undefined; imageHostPath(ref: AttachmentRef): string | undefined;
  };
  storageDomain: { open(spec: object): Promise<{ table(name: string): Table<TaskRecord>; close(): Promise<void> }> };
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void };
  typert: { register(contribution: object): () => void };
  provide(name: string, service: object): () => void;
  effect(callback: () => (() => void | Promise<void>)): unknown;
  on?(event: string, callback: (this: unknown, ...args: unknown[]) => unknown): () => void;
  logger?(name: string): { info(message: string): void; error(message: string): void };
}
