import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_VOICE_ID,
  FpsSchema,
  SegmentKindSchema,
  SfxSlugSchema,
  VoiceIdSchema,
} from '../contracts/index.js';
import {
  TtsEngineService,
  extractAndProbeMedia as extractAndProbeCore,
  mixMasterAudio as mixMasterAudioCore,
  type ExtractAndProbeResult,
  type MixMasterAudioResult,
  type SynthesizeVoiceResult,
  type TtsBackendAdapter,
} from '../audio/index.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export const SynthesizeVoiceSegmentsInputSchema = z.object({
  segments: z
    .array(
      z.object({
        segmentId: z.string().min(1),
        kind: SegmentKindSchema,
        ttsText: z.string().min(1),
        sourceCommentId: z.string().min(1).optional(),
      }),
    )
    .min(1),
  voiceId: VoiceIdSchema.default(DEFAULT_VOICE_ID),
  refAudioPath: z.string().min(1).optional(),
  outputDir: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});
export type SynthesizeVoiceSegmentsInput = z.input<
  typeof SynthesizeVoiceSegmentsInputSchema
>;

export function synthesizeVoiceSegments(
  input: SynthesizeVoiceSegmentsInput & {
    adapters?: readonly TtsBackendAdapter[];
    daemonUrl?: string;
    pythonBin?: string;
  },
): Promise<CodeModeResult<SynthesizeVoiceResult>> {
  return runCodeMode(async () => {
    const parsed = SynthesizeVoiceSegmentsInputSchema.parse(input);
    const outputDir =
      parsed.outputDir ??
      path.join(os.tmpdir(), 'videothreads', 'tts', String(Date.now()));

    const engine = new TtsEngineService({
      adapters: input.adapters,
      daemonUrl: input.daemonUrl,
      pythonBin: input.pythonBin,
    });

    return engine.synthesizeSegments(parsed.segments, {
      voiceId: parsed.voiceId,
      refAudioPath: parsed.refAudioPath,
      outputDir,
      timeoutMs: parsed.timeoutMs,
    });
  });
}

export const ExtractAndProbeMediaInputSchema = z.object({
  inputPath: z.string().min(1),
  outputPath: z.string().min(1).optional(),
  trimStartSec: z.number().nonnegative().optional(),
  trimEndSec: z.number().positive().optional(),
  toWav48k: z.boolean().optional(),
});
export type ExtractAndProbeMediaInput = z.input<
  typeof ExtractAndProbeMediaInputSchema
>;

export function extractAndProbeMedia(
  input: ExtractAndProbeMediaInput,
): Promise<CodeModeResult<ExtractAndProbeResult>> {
  return runCodeMode(() => {
    const parsed = ExtractAndProbeMediaInputSchema.parse(input);
    return extractAndProbeCore(parsed);
  });
}

const SynthesizedSegmentAudioSchema = z.object({
  segmentId: z.string().min(1),
  kind: SegmentKindSchema,
  sourceCommentId: z.string().min(1).optional(),
  wavPath: z.string().min(1),
  sampleRate: z.literal(48000),
  channels: z.number().int().positive(),
  numSamples: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  trimmedLeadingMs: z.number().nonnegative(),
  wordTimings: z.array(
    z.object({
      word: z.string(),
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
    }),
  ),
  backendUsed: z.enum(['vieneu_gpu', 'vieneu_onnx_cpu', 'edge_tts']),
});

export const MixMasterAudioInputSchema = z.object({
  voiceSegments: z.array(SynthesizedSegmentAudioSchema).min(1),
  audioCues: z
    .array(
      z.object({
        cueId: z.string().min(1),
        sfxSlug: SfxSlugSchema,
        sfxFilePath: z.string().min(1),
        triggerMs: z.number().nonnegative(),
        volumeDb: z.number().min(-30).max(0).optional(),
      }),
    )
    .optional(),
  bgmPath: z.string().min(1).optional(),
  bgmVolumeDb: z.number().min(-40).max(0).optional(),
  outputPath: z.string().min(1),
  fps: FpsSchema.default(60),
});
export type MixMasterAudioInput = z.input<typeof MixMasterAudioInputSchema>;

export function mixMasterAudio(
  input: MixMasterAudioInput,
): Promise<CodeModeResult<MixMasterAudioResult>> {
  return runCodeMode(() => {
    const parsed = MixMasterAudioInputSchema.parse(input);
    return mixMasterAudioCore(parsed);
  });
}
