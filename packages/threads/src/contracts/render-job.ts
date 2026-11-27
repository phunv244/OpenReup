import { z } from 'zod';
import {
  DEFAULT_VOICE_ID,
  ErrorCodeSchema,
  FpsSchema,
  ThemeSchema,
  ThreadsPostUrlSchema,
  VoiceIdSchema,
} from './common.js';
import { AIDirectorOutputSchema } from './ai-director.js';
import { NormalizedThreadsPostSchema } from './threads-post.js';

export const RenderJobStatusSchema = z.enum([
  'QUEUED',
  'SCRAPING',
  'DIRECTING',
  'TTS_MIXING',
  'RENDERING',
  'COMPLETED',
  'FAILED',
]);
export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const LatencyBreakdownMsSchema = z.object({
  scrape: z.number().nonnegative().optional(),
  ai: z.number().nonnegative().optional(),
  tts: z.number().nonnegative().optional(),
  render: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
});
export type LatencyBreakdownMs = z.infer<typeof LatencyBreakdownMsSchema>;

export const RenderJobSchema = z.object({
  id: z.string().min(1),
  postId: z.string().min(1).nullable(),
  scriptId: z.string().min(1).nullable(),
  status: RenderJobStatusSchema,
  fps: FpsSchema.default(60),
  theme: ThemeSchema.default('dark'),
  voiceId: VoiceIdSchema.default(DEFAULT_VOICE_ID),
  outputVideoPath: z.string().min(1).nullable(),
  videoDurationSec: z.number().positive().nullable(),
  latencyBreakdownMs: LatencyBreakdownMsSchema.nullable(),
  errorCode: ErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number().int().positive(),
  completedAt: z.number().int().positive().nullable(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

export const MediaAssetCategorySchema = z.enum([
  'GAMEPLAY',
  'BGM',
  'SFX',
  'STICKER',
]);
export type MediaAssetCategory = z.infer<typeof MediaAssetCategorySchema>;

export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  category: MediaAssetCategorySchema,
  filePath: z.string().min(1),
  durationSec: z.number().nonnegative().nullable(),
  tags: z.array(z.string().min(1)).default([]),
  isActive: z.boolean().default(true),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/** POST /api/v1/analyze */
export const AnalyzeRequestSchema = z.object({
  url: ThreadsPostUrlSchema,
  forceRefresh: z.boolean().default(false),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

export const AnalyzeResponseSchema = z.object({
  success: z.literal(true),
  post: NormalizedThreadsPostSchema,
  directorScript: AIDirectorOutputSchema,
});
export type AnalyzeResponse = z.infer<typeof AnalyzeResponseSchema>;

/** POST /api/v1/jobs */
export const CreateJobRequestSchema = z
  .object({
    url: ThreadsPostUrlSchema.optional(),
    scriptId: z.string().min(1).optional(),
    fps: FpsSchema.default(60),
    theme: ThemeSchema.default('dark'),
    voiceId: VoiceIdSchema.default(DEFAULT_VOICE_ID),
  })
  .refine((data) => Boolean(data.url) || Boolean(data.scriptId), {
    message: 'Either url or scriptId must be provided',
  });
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const CreateJobResponseSchema = z.object({
  success: z.literal(true),
  jobId: z.string().min(1),
  status: RenderJobStatusSchema,
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

/** GET /api/v1/jobs/:jobId */
export const JobDetailResponseSchema = z.object({
  success: z.literal(true),
  job: RenderJobSchema,
  downloadUrl: z.string().min(1).nullable(),
});
export type JobDetailResponse = z.infer<typeof JobDetailResponseSchema>;

/** GET /api/v1/jobs/:jobId/events (SSE) */
export const JobSseEventSchema = z.object({
  jobId: z.string().min(1),
  status: RenderJobStatusSchema,
  progress: z.number().min(0).max(100),
  renderedFrames: z.number().int().nonnegative().optional(),
  totalFrames: z.number().int().positive().optional(),
  message: z.string().optional(),
  timestamp: z.number().int().positive(),
});
export type JobSseEvent = z.infer<typeof JobSseEventSchema>;

/** Standard API Error payload matching STATE_MATRIX.md Section 5 */
export const ApiErrorResponseSchema = z.object({
  success: z.literal(false),
  code: ErrorCodeSchema,
  message: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
