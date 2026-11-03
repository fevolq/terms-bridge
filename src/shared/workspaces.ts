/** Settings-only Remote method; shares dsh's authenticated connection. */
export const WORKSPACES_REMOTE = {
  package: '@fevolq/terms-bridge',
  descriptors: [{
    id: '@fevolq/terms-bridge#termsBridge/workspaces', service: 'termsBridge', namespace: 'termsBridge',
    method: 'workspaces', invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
  }],
} as const;
