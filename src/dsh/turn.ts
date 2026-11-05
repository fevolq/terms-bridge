import type { TaskRecord } from '../domain/types.js';
import type { Agent, ContentBlock, Host, SessionEvent } from './host.js';
import { attemptEvents } from './results.js';
import { assertIdle } from './sessions.js';
import { configureTask } from './models.js';

/** Follow one message and hold subsequent execution until its result files are saved. */
export function sendTask(host: Host, agent: Agent, task: TaskRecord, content: ContentBlock[], signal: AbortSignal) {
  const id = task.execution.attempt_id!;
  let turn: number | undefined, sent = false, ended = false, released = false, failure: unknown;
  let releasePolicy: (() => void) | undefined;
  const stop: (() => void)[] = [];
  let finish!: (events: readonly SessionEvent[]) => void, fail!: (error: unknown) => void, unblock!: () => void;
  const completed = new Promise<readonly SessionEvent[]>((resolve, reject) => { finish = resolve; fail = reject; });
  const filesSaved = new Promise<void>(resolve => { unblock = resolve; });
  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    // Native selection restoration appends an event. DSH forbids reentrant
    // appends while turn/end is being published, so release after publication.
    queueMicrotask(() => {
      try {
        releasePolicy?.();
        if (error !== undefined) throw error;
        finish(attemptEvents(agent.session.snapshotEvents(), id));
      } catch (cause) { fail(cause); }
    });
  };
  const cancel = () => {
    if (ended || !sent) return;
    // Removing our queued message never cancels maintenance or another owner's turn.
    if (agent.inbox.remove(id)) return;
    if (turn !== undefined) agent.cancel({ kind: 'hook', reason: 'terms-bridge stopped' }, { keepInbox: true });
  };
  const close = async () => {
    try { cancel(); await completed.catch(() => {}); }
    finally {
      signal.removeEventListener('abort', cancel);
      try { releasePolicy?.(); for (const dispose of stop.reverse()) dispose(); }
      finally { released = true; unblock(); }
    }
  };
  try {
    signal.throwIfAborted(); assertIdle(agent, task.request.metadata);
    stop.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent === agent && ended && !released) await filesSaved;
      return next();
    }, { prepend: true }));
    stop.push(agent.ctx.on('agent/inbox/claimed', payload => {
      if (payload.agent !== agent || payload.message.id !== id) return;
      turn = payload.turn;
      try {
        signal.throwIfAborted();
        releasePolicy = configureTask(host, agent, task);
        host.permissionPresets.set(agent.session, task.project.permission_mode);
      } catch (error) { failure = error; cancel(); }
    }));
    stop.push(agent.ctx.on('agent/inbox/discarded', payload => {
      if (payload.agent === agent && payload.message.id === id) end(signal.aborted ? signal.reason : new Error('Task message was discarded'));
    }));
    stop.push(agent.ctx.on('session/event', (source, event) => {
      if (source === agent.session && event.type === 'turn/end' && turn !== undefined && event.data.turn === turn) end(failure);
    }));
    signal.addEventListener('abort', cancel, { once: true });
    sent = true;
    agent.followup({ id, role: 'user', source: { kind: 'user' }, content });
    // A fallback for host disposal or an empty/rejected turn; never wait for later UI work.
    void agent.whenIdle().then(() => end(new Error('Task message ended without a completed turn')), error => end(error));
  } catch (error) {
    failure = error;
    cancel();
    if (turn === undefined) end(error);
  }
  return { completed, close };
}
