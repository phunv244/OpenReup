import { z } from 'zod';
import {
  VideoCompositionPropsSchema,
  type VideoCompositionProps,
} from '../contracts/video-composition.js';
import {
  buildVideoCompositionProps as buildCore,
  type BuildVideoCompositionPropsOptions,
} from '../remotion/builder.js';
import {
  openVideoPreview as openPreviewCore,
  renderPreviewStill as renderStillCore,
  renderThreadsVideo as renderVideoCore,
  type OpenVideoPreviewResult,
  type RenderStillResult,
  type RenderVideoResult,
} from '../remotion/renderer.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export function buildVideoCompositionProps(
  options: BuildVideoCompositionPropsOptions,
): Promise<CodeModeResult<VideoCompositionProps>> {
  return runCodeMode(() => {
    return buildCore(options);
  });
}

export const OpenVideoPreviewInputSchema = z
  .object({
    port: z.number().int().positive().default(3001),
  })
  .default({});
export type OpenVideoPreviewInput = z.input<typeof OpenVideoPreviewInputSchema>;

export function openVideoPreview(
  input?: OpenVideoPreviewInput,
): Promise<CodeModeResult<OpenVideoPreviewResult>> {
  return runCodeMode(() => {
    const parsed = OpenVideoPreviewInputSchema.parse(input ?? {});
    return openPreviewCore(parsed);
  });
}

export const RenderPreviewStillInputSchema = z.object({
  props: VideoCompositionPropsSchema,
  outputPath: z.string().min(1).optional(),
  frame: z.number().int().nonnegative().optional(),
  theme: z.enum(['dark', 'light']).optional(),
});
export type RenderPreviewStillInput = z.input<typeof RenderPreviewStillInputSchema>;

export function renderPreviewStill(
  input: RenderPreviewStillInput,
): Promise<CodeModeResult<RenderStillResult>> {
  return runCodeMode(() => {
    const parsed = RenderPreviewStillInputSchema.parse(input);
    return renderStillCore(parsed.props, {
      outputPath: parsed.outputPath,
      frame: parsed.frame,
      theme: parsed.theme,
    });
  });
}

export const RenderThreadsVideoInputSchema = z.object({
  props: VideoCompositionPropsSchema,
  outputPath: z.string().min(1).optional(),
  codec: z.enum(['h264', 'h265', 'vp8', 'vp9']).optional(),
  crf: z.number().int().min(0).max(51).optional(),
  concurrency: z.number().int().min(1).max(12).optional(),
});
export type RenderThreadsVideoInput = z.input<typeof RenderThreadsVideoInputSchema> & {
  onProgress?: (progress: number) => void;
};

export function renderThreadsVideo(
  input: RenderThreadsVideoInput,
): Promise<CodeModeResult<RenderVideoResult>> {
  return runCodeMode(() => {
    const parsed = RenderThreadsVideoInputSchema.parse(input);
    return renderVideoCore(parsed.props, {
      outputPath: parsed.outputPath,
      codec: parsed.codec,
      crf: parsed.crf,
      concurrency: parsed.concurrency,
      onProgress: input.onProgress,
    });
  });
}
