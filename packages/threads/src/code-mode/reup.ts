import { z } from 'zod';
import {
  buildOriginalAudioFilterChain,
  type OriginalAudioFilterSpec,
} from '../audio/ffmpeg-mastering.js';
import {
  extractThreadsVideo as extractThreadsVideoCore,
  probeNvenc as probeNvencCore,
  runReupThreadsPipeline as runReupThreadsPipelineCore,
  OriginalAudioVolumePctSchema,
  type ExtractThreadsVideoOptions,
  type ExtractThreadsVideoResult,
  type NvencProbeResult,
  type RunReupThreadsPipelineOptions,
  type RunReupThreadsPipelineResult,
} from '../reup/index.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export const ExtractThreadsVideoInputSchema = z.object({
  url: z.string().min(1),
  outputDir: z.string().min(1).optional(),
  maxDurationSec: z.number().positive().max(3600).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  bypassCache: z.boolean().optional(),
  enableTier2Fallback: z.boolean().optional(),
});

export function extractThreadsVideo(
  options: ExtractThreadsVideoOptions,
): Promise<CodeModeResult<ExtractThreadsVideoResult>> {
  return runCodeMode(async (warnings) => {
    ExtractThreadsVideoInputSchema.parse(options);
    const result = await extractThreadsVideoCore(options);
    warnings.push(...result.warnings);
    return result;
  });
}

export const RunReupThreadsPipelineInputSchema = z
  .object({
    url: z.string().min(1).optional(),
    localVideoPath: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
    workDir: z.string().min(1).optional(),
    outputPath: z.string().min(1).optional(),
    voiceId: z.string().min(1).optional(),
    refAudioPath: z.string().min(1).optional(),
    originalAudioVolumePct: OriginalAudioVolumePctSchema.optional(),
    maxDurationSec: z.number().positive().max(3600).optional(),
    delogo: z.string().optional(),
    subcover: z.string().optional(),
    burnSub: z.boolean().optional(),
    fontName: z
      .string()
      .regex(/^[A-Za-z0-9 _.-]{1,64}$/, 'fontName contains disallowed characters')
      .optional(),
    fontsDir: z.string().optional(),
    agyModel: z.string().optional(),
    agyBin: z.string().optional(),
    skipAgy: z.boolean().optional(),
    encoder: z.enum(['auto', 'nvenc', 'cpu']).optional(),
    fps: z.union([z.literal(30), z.literal(60)]).optional(),
  })
  .refine((data) => Boolean(data.url || data.localVideoPath), {
    message: 'Either url or localVideoPath must be provided to runReupThreadsPipeline',
    path: ['url'],
  });

export function runReupThreadsPipeline(
  options: RunReupThreadsPipelineOptions,
): Promise<CodeModeResult<RunReupThreadsPipelineResult>> {
  return runCodeMode(() => {
    RunReupThreadsPipelineInputSchema.parse(options);
    return runReupThreadsPipelineCore(options);
  });
}

export function probeReupNvenc(options?: {
  ffmpegBin?: string;
  force?: boolean;
}): Promise<CodeModeResult<NvencProbeResult>> {
  return runCodeMode(() => probeNvencCore(options));
}

export function buildOriginalAudioDspFilter(input: {
  originalAudioVolumePct: number;
}): Promise<CodeModeResult<OriginalAudioFilterSpec>> {
  return runCodeMode(() => {
    const parsed = z
      .object({ originalAudioVolumePct: OriginalAudioVolumePctSchema })
      .parse(input);
    return buildOriginalAudioFilterChain(parsed.originalAudioVolumePct);
  });
}
