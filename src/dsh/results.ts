import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../domain/request.js';
import { inside, regularFile } from '../storage/paths.js';
import type { ContentBlock, SessionEvent } from './host.js';

/** Match the submitted message, not whichever turn happened to finish last. */
export function attemptEvents(events: readonly SessionEvent[], messageId: string): readonly SessionEvent[] {
  let start = -1, matched = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === 'turn/start') { start = index; matched = false; }
    if (event.type === 'user/message' && event.data.id === messageId && start >= 0) matched = true;
    if (event.type === 'turn/end' && matched) return events.slice(start, index + 1);
  }
  throw new Error('Submitted task has no completed turn');
}

export function finalResponse(events: readonly SessionEvent[]): ContentBlock[] {
  let ended = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'turn/start') break;
    if (!ended) {
      if (event.type !== 'turn/end') continue;
      if (event.data.reason?.kind !== 'completed') throw new Error('Session did not complete normally');
      ended = true;
    } else if (event.type === 'assistant/message') {
      const blocks = event.data.message?.content;
      if (!blocks || blocks.some(block => block.type === 'tool-call')) break;
      return blocks;
    }
  }
  throw new Error('Session has no final assistant reply');
}
/** Native present cards are delivered separately from the assistant's final text. */
export function presentedFiles(events: readonly SessionEvent[]): string[] {
  let ended = false, turn: number | undefined;
  const paths: string[] = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'turn/start') break;
    if (!ended) {
      if (event.type !== 'turn/end') continue;
      if (event.data.reason?.kind !== 'completed') return [];
      ended = true; turn = event.data.turn;
    } else if (event.type === 'deliverables/presented' && event.data.turn === turn) {
      paths.unshift(...(event.data.files ?? []).map(file => file.path));
    }
  }
  return paths;
}
export async function localResultPaths(references: readonly string[], workspace: string): Promise<string[]> {
  const root = await realpath(workspace), result: string[] = [];
  for (let reference of references) {
    try {
      if (reference.startsWith('file://')) reference = fileURLToPath(reference);
      else if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) continue;
      const path = resolve(root, reference);
      if (!inside(root, path)) continue;
      await regularFile(path);
      result.push(path);
    } catch (error) {
      if (error instanceof URIError || error instanceof ApiError && error.code === 'FILE_UNAVAILABLE') continue;
      if (['ENOENT', 'ENOTDIR', 'ERR_INVALID_FILE_URL_PATH', 'ERR_INVALID_FILE_URL_HOST'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
  }
  return result;
}
export async function referencedPaths(text: string, workspace: string): Promise<string[]> {
  const references: string[] = [];
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|((?:[^()\s]|\([^()]*\))+))(?:\s+"[^"]*")?\s*\)|`([^`\r\n]+)`/g;
  for (const match of text.matchAll(pattern)) {
    try {
      const reference = match[1] ?? match[2] ?? match[3]!;
      references.push(match[3] !== undefined || reference.startsWith('file://') ? reference : decodeURIComponent(reference));
    } catch (error) { if (!(error instanceof URIError)) throw error; }
  }
  return localResultPaths(references, workspace);
}
