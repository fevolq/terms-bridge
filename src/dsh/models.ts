import type { Agent, Host, ModelSelection } from './host.js';
import type { TaskRecord } from '../domain/types.js';

interface SessionModels {
  selectionFor(agent: Agent): { readonly current: ModelSelection };
  selectForNextRequest(agent: Agent, selection: ModelSelection): void;
}

/** DSH 0.2.1 exposes session-only selection on this internal component. Keep this
 * version-dependent access here: public selectModel also writes the host default. */
export function sessionModels(host: Host): SessionModels {
  const models = (host.sessionController as unknown as { agents?: SessionModels }).agents;
  if (typeof models?.selectionFor !== 'function' || typeof models.selectForNextRequest !== 'function') {
    throw new Error('Incompatible DSH session model-selection component for terms-bridge');
  }
  return models;
}
const sameModel = (a: ModelSelection, b: ModelSelection) =>
  a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;

/** Choose through DSH so routing, prompt variables and native notices agree. */
export function configureTask(host: Host, agent: Agent, task: TaskRecord): () => void {
  const models = sessionModels(host), release: (() => void)[] = [];
  let restore = host.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending ?? undefined;
  let selecting = false;
  const select = (selection: ModelSelection) => {
    if (sameModel(models.selectionFor(agent).current, selection)) return;
    selecting = true;
    try { models.selectForNextRequest(agent, selection); }
    finally { selecting = false; }
  };
  const dispose = () => { for (const stop of release.splice(0).reverse()) stop(); };
  try {
    release.push(agent.ctx.on('session/event', (source, event) => {
      if (source === agent.session && event.type === 'model/selection' && !selecting) {
        restore = { provider: event.data.provider!, model: event.data.model!,
          ...(event.data.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.reasoningEffort }) };
      }
    }));
    // Preserve a model the UI selected for its own followup, including choices made mid-task.
    release.push(() => { if (restore) select(restore); });
    if (agent.ctx.tools.get('ask_user_question', agent)) release.push(agent.ctx.tools.restrict({ deny: ['ask_user_question'] }));
    release.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === agent) {
        const { provider, model } = task.project, current = models.selectionFor(agent).current;
        select({ provider, model, ...(current.provider === provider && current.model === model && current.reasoningEffort !== undefined
          ? { reasoningEffort: current.reasoningEffort } : {}) });
      }
      return next();
    }, { prepend: true }));
    return dispose;
  } catch (error) { dispose(); throw error; }
}
