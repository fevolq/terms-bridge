import { z } from 'zod';
import { FILE_ID, PROJECT_ID, LIMITS } from '../shared/rules.js';

export const uploadedFileSchema = z.object({
  file_id: z.string().regex(FILE_ID), project_id: z.string().regex(PROJECT_ID),
  filename: z.string().min(1).refine(value => Buffer.byteLength(value) <= 255 && !/[\x00-\x1f\x7f/\\]/.test(value) && !['.', '..'].includes(value)),
  media_type: z.string().max(200), size: z.number().int().min(0).max(LIMITS.file),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), created_at: z.string().datetime(),
}).strict();
