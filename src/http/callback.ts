import type { TaskRecord } from '../domain/types.js';

export async function sendCallback(task: TaskRecord, stop: AbortSignal, request: typeof fetch = fetch): Promise<string | null> {
  const timeout = AbortSignal.timeout(task.project.callback_timeout_seconds * 1000);
  try {
    const response = await request(task.project.callback_url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.any([stop, timeout]), body: task.callback_body!,
      headers: { ...task.project.callback_headers, 'Content-Type': 'application/json', 'X-DSH-Protocol-Version': '2' },
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300 ? null : `HTTP ${response.status}`;
  } catch {
    // A transport exception may contain credentials or URLs; persist only a stable code.
    return stop.aborted ? 'CALLBACK_INTERRUPTED' : timeout.aborted ? 'CALLBACK_TIMEOUT' : 'CALLBACK_TRANSPORT_OR_CREDENTIAL_ERROR';
  }
}
