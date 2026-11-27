import { z } from 'zod';
import {
  runThreadsVideoPipeline as runPipelineCore,
  type RunThreadsVideoPipelineOptions,
  type RunThreadsVideoPipelineResult,
} from '../pipeline/threads-video-pipeline.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export const RunThreadsVideoPipelineInputSchema = z
  .object({
    url: z.string().optional(),
    scrapedPost: z.any().optional(),
    jobId: z.string().optional(),
    voiceId: z.string().optional(),
    refAudioPath: z.string().optional(),
    theme: z.enum(['dark', 'light']).optional(),
    fps: z.union([z.literal(30), z.literal(60)]).optional(),
    dimOpacity: z.number().min(0).max(1).optional(),
    backgroundVideoPath: z.string().optional(),
    outputPath: z.string().optional(),
    previewStillPath: z.string().optional(),
    maxComments: z.number().int().min(1).max(5).optional(),
    onProgress: z.function().optional(),
    ttsAdapters: z.array(z.any()).optional(),
  })
  .refine((data) => Boolean(data.url || data.scrapedPost), {
    message: 'Either url or scrapedPost must be provided to runThreadsVideoPipeline',
    path: ['url'],
  });

export function runThreadsVideoPipeline(
  options: RunThreadsVideoPipelineOptions,
): Promise<CodeModeResult<RunThreadsVideoPipelineResult>> {
  return runCodeMode(() => {
    RunThreadsVideoPipelineInputSchema.parse(options);
    return runPipelineCore(options);
  });
}
