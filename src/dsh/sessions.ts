import { ApiError } from '../domain/request.js';
import type { TaskMetadata, TaskRecord } from '../domain/types.js';
import type { Agent, Host } from './host.js';

export const agentBusy = (agent: Agent | undefined): boolean => !!agent && (agent.status !== 'idle' || agent.inbox.nextTurn.length > 0);
export function assertIdle(agent: Agent, metadata: TaskMetadata): void {
  if (agentBusy(agent)) throw new ApiError(409, 'CONVERSATION_BUSY', 'Conversation has an unfinished task', metadata);
}

/** Stop waiting without canceling a native activation that the UI may also be using. */
async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** DSH owns activation, preset composition and runtime lifetime. We retain only its ID. */
export async function openSession(host: Host, task: TaskRecord, signal: AbortSignal, created: boolean): Promise<Agent> {
  signal.throwIfAborted();
  const id = task.execution.session_id;
  let agent = host.agents.get(id);
  if (!agent) {
    const exists = (await host.sessionPersistence.stat(id)) !== undefined;
    signal.throwIfAborted();
    if (!exists && created) throw new Error('Conversation session no longer exists');
    if (!exists) {
      const result = await waitFor(host.sessionController.create({ sessionId: id, cwd: task.project.workspace_path,
        agentPreset: task.project.agent_preset }), signal);
      if (result.sessionId !== id) throw new Error('DSH returned a different conversation identity');
    }
    const result = await waitFor(host.sessionController.resolveAgent(id), signal);
    if ('error' in result) throw result.error;
    agent = result.agent;
  }
  signal.throwIfAborted(); assertIdle(agent, task.request.metadata);
  return agent;
}
