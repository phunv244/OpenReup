import { z } from 'zod';
import type { Fps, VoiceId } from '../contracts/index.js';
import type { TtsBackendAdapter } from '../audio/tts-engine.js';
import type { FetchLike, ScraperServiceConfig } from '../scraper/types.js';

export const REUP_PIPELINE_STEPS = [
  'INGEST',
  'PROBE',
  'TRANSCRIBE',
  'ADAPT_SCRIPT',
  'DUB_AND_MASTER',
  'RENDER_EXPORT',
] as const;

export type ReupPipelineStep = (typeof REUP_PIPELINE_STEPS)[number];

export const DEFAULT_MAX_REUP_DURATION_SEC = 180 as const;
export const DEFAULT_MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

export const REGION_PATTERN = /^(\d+),(\d+),(\d+),(\d+)$/;
export const SAFE_FONT_NAME_PATTERN = /^[A-Za-z0-9 _.-]{1,64}$/;

export interface ReupTranscriptSegment {
  id: number;
  startSec: number;
  endSec: number;
  sourceText: string;
  adaptedText?: string;
}

export interface NvencProbeResult {
  available: boolean;
  encoder: 'h264_nvenc' | 'libx264';
  reason: string;
}

export interface ExtractThreadsVideoOptions {
  url: string;
  outputDir?: string;
  maxDurationSec?: number;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  bypassCache?: boolean;
  enableTier2Fallback?: boolean;
  serviceConfig?: Partial<ScraperServiceConfig>;
  fetchFn?: FetchLike;
  ffmpegBin?: string;
  ffprobeBin?: string;
}

export interface ExtractThreadsVideoResult {
  shortcode: string;
  canonicalUrl: string;
  authorHandle: string;
  caption: string;
  videoUrl: string;
  localVideoPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  source: 'tier1_ssr' | 'tier2_playwright';
  warnings: string[];
}

export interface ReupCheckpoint {
  jobId: string;
  completedSteps: ReupPipelineStep[];
  ingestedVideoPath?: string;
  shortcode?: string;
  caption?: string;
  authorHandle?: string;
  probe?: {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
  };
  transcript?: ReupTranscriptSegment[];
  adaptedSegments?: ReupTranscriptSegment[];
  masterAudioPath?: string;
  subtitlePath?: string;
  outputVideoPath?: string;
  updatedAt: string;
}

export interface RunReupThreadsPipelineOptions {
  url?: string;
  localVideoPath?: string;
  jobId?: string;
  workDir?: string;
  outputPath?: string;
  voiceId?: VoiceId;
  refAudioPath?: string;
  originalAudioVolumePct?: number;
  maxDurationSec?: number;
  delogo?: string;
  subcover?: string;
  burnSub?: boolean;
  fontName?: string;
  fontsDir?: string;
  agyModel?: string;
  agyBin?: string;
  skipAgy?: boolean;
  encoder?: 'auto' | 'nvenc' | 'cpu';
  fps?: Fps;
  segments?: readonly ReupTranscriptSegment[];
  adaptedSegments?: readonly ReupTranscriptSegment[];
  ttsAdapters?: readonly TtsBackendAdapter[];
  serviceConfig?: Partial<ScraperServiceConfig>;
  fetchFn?: FetchLike;
  ffmpegBin?: string;
  ffprobeBin?: string;
  onProgress?: (step: ReupPipelineStep, percent: number, label: string) => void;
}

export interface RunReupThreadsPipelineResult {
  jobId: string;
  stepsCompleted: ReupPipelineStep[];
  inputVideoPath: string;
  masterAudioPath: string;
  subtitlePath?: string;
  outputVideoPath: string;
  durationSec: number;
  encoderUsed: 'h264_nvenc' | 'libx264';
  originalAudioVolumePct: number;
  limiterApplied: boolean;
  loudnessTargetLufs: -14;
  segmentCount: number;
  checkpointPath: string;
  elapsedMs: number;
}

export const OriginalAudioVolumePctSchema = z
  .number()
  .finite()
  .min(0, 'originalAudioVolumePct must be >= 0')
  .max(200, 'originalAudioVolumePct must be <= 200');
