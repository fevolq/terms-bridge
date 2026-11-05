import { join } from 'node:path';

// Exercise the host's actual session creation, restoration and model-selection owner.
export async function mountNativeController(ctx, mount, load, root, fibers, selection = { provider: 'test', model: 'host-default' }) {
  if (!ctx.get('typert')) await mount('dsh-typert-registry');
  if (!ctx.get('attachments')) await mount('dsh-attachment-local', { dshHome: join(root, 'attachments') });
  if (!ctx.get('fs')) await mount('dsh-fs-local', { cwd: root });
  await mount('dsh-agent-default-model', selection);
  await mount('dsh-api-remote-access');
  await mount('dsh-session-query-sqlite', { path: join(root, 'query.sqlite'), openAt: 'first-search' });
  // Upload transport is not used: bridge attachments go through the real attachment service.
  const { Service } = await load('cordis');
  class FileUploads extends Service {
    constructor(c) { super(c, 'fileUploads'); }
    registerAgentResolver() { return () => {}; }
  }
  const uploads = ctx.plugin(FileUploads); fibers.push(uploads); await uploads.await();
  await mount('dsh-api-session-controller', { nativeOpen: false });
  return fibers.at(-1);
}
