import { LIMITS } from './rules.js';

export interface ConfigOperation { op: 'set' | 'unset'; path: string[]; value?: unknown }
/** Small, shared wire validators; field semantics are checked by the configuration service. */
export function parseOperations(value: unknown): ConfigOperation[] {
  if (!Array.isArray(value) || value.length > 10000 || new TextEncoder().encode(JSON.stringify(value)).length > LIMITS.json)
    throw new Error('配置修改格式不正确或超过大小限制');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['set', 'unset'].includes(item.op) ||
      !Array.isArray(item.path) || item.path.length < 1 || item.path.length > 3 || item.path.some((part: unknown) => typeof part !== 'string') ||
      Object.keys(item).some(key => !['op', 'path', 'value'].includes(key)) || item.op === 'set' && !Object.hasOwn(item, 'value'))
      throw new Error('配置修改格式不正确');
  }
  return value as ConfigOperation[];
}
export function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('配置版本无效');
  return value;
}
