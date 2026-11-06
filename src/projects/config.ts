import { z } from 'zod';
import { API_PREFIX, API_PATTERN, DEFAULTS, LIMITS, PERMISSIONS, PROJECT_ID, TOKEN_PATTERN, callbackHeadersError, callbackUrlValid } from '../shared/rules.js';
import type { PluginConfig } from '../domain/types.js';

const positive = z.number().int().min(1).max(LIMITS.numeric);
const optionalText = z.string().trim().transform(value => value || undefined).optional();
export const projectSchema = z.object({
  name: z.string().min(1).optional(), created_at: z.string().datetime().optional(), workspace_path: optionalText,
  provider: z.string().min(1), model: z.string().min(1), agent_preset: optionalText,
  permission_mode: z.enum(PERMISSIONS).default(DEFAULTS.permission_mode),
  max_concurrency: z.number().int().min(0).max(LIMITS.numeric).default(DEFAULTS.max_concurrency),
  callback_url: z.string().url().refine(callbackUrlValid, 'Callback URL must be HTTP(S), without credentials or fragment'),
  request_token: z.string().regex(TOKEN_PATTERN).transform(value => value || undefined).optional(),
  callback_headers: z.record(z.string(), z.string()).superRefine((value, context) => {
    const message = callbackHeadersError(value);
    if (message) context.addIssue({ code: 'custom', message });
  }).default({}),
  max_execution_retries: z.number().int().min(0).max(LIMITS.executionRetries).default(DEFAULTS.max_execution_retries),
  execution_timeout_seconds: positive.default(DEFAULTS.execution_timeout_seconds),
  retry_interval_seconds: positive.default(DEFAULTS.retry_interval_seconds),
  callback_timeout_seconds: positive.default(DEFAULTS.callback_timeout_seconds),
}).strict();
const configSchema = z.object({
  api_prefix: z.string().regex(API_PATTERN).default(API_PREFIX),
  projects: z.record(z.string().regex(PROJECT_ID), projectSchema).default({}),
}).strict();
export function parseConfig(input: unknown): PluginConfig {
  const config = configSchema.parse(input);
  return { ...config, projects: Object.fromEntries(Object.entries(config.projects).map(([id, project]) => [id, { ...project, name: project.name ?? id }])) };
}
