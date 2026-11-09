import { parseOperations, parseRevision } from './settings.js';
/** Project configuration Remote methods; shares dsh's authenticated connection. */
export const WORKSPACES_REMOTE = {
  package: '@fevolq/terms-bridge',
  descriptors: [{
    id: '@fevolq/terms-bridge#termsBridge/workspaces', service: 'termsBridge', namespace: 'termsBridge',
    method: 'workspaces', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
  }, ...(['settings', 'mutate'] as const).map(method => ({
    id: '@fevolq/terms-bridge#termsBridge/' + method, service: 'termsBridge', namespace: 'termsBridge', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'mutate' ? ['ops', 'revision'].map(name => ({ name, wire: name, source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: '@fevolq/terms-bridge#' + name, create: () => ({ parse: name === 'ops' ? parseOperations : parseRevision }) } })) : [],
    result: { mode: 'src-json' as const },
  }))],
} as const;
