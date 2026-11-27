import type { ErrorCode, Fps, SegmentKind, SfxSlug, VoiceId } from '../contracts/index.js';
import { resolveOpenReupPythonBin } from '../paths.js';

export const AUDIO_SAMPLE_RATE = 48_000 as const;
export const AUDIO_CHANNELS = 2 as const;
export const TTS_GPU_CONCURRENCY = 1 as const;
export const DEFAULT_TTS_TIMEOUT_MS = 20_000;
export const DEFAULT_VIENEU_DAEMON_URL = process.env['VIENEU_DAEMON_URL'] ?? '';
export const DEFAULT_VIENEU_PYTHON_BIN = resolveOpenReupPythonBin();

export type TtsBackend = 'vieneu_gpu' | 'vieneu_onnx_cpu' | 'edge_tts';

export type AudioErrorCode = Extract<
  ErrorCode,
  'ERR_TTS_SYNTHESIS_FAILED' | 'ERR_RENDER_FAILED' | 'ERR_VALIDATION_FAILED'
>;

export class AudioError extends Error {
  readonly code: AudioErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AudioErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AudioError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export interface WordTimingMs {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TtsSegmentInput {
  segmentId: string;
  kind: SegmentKind;
  ttsText: string;
  sourceCommentId?: string;
}

export interface SynthesizedSegmentAudio {
  segmentId: string;
  kind: SegmentKind;
  sourceCommentId?: string;
  wavPath: string;
  sampleRate: 48000;
  channels: number;
  numSamples: number;
  durationMs: number;
  trimmedLeadingMs: number;
  wordTimings: WordTimingMs[];
  backendUsed: TtsBackend;
}

export interface SynthesizeVoiceOptions {
  voiceId?: VoiceId;
  refAudioPath?: string;
  outputDir: string;
  timeoutMs?: number;
}

export interface SynthesizeVoiceResult {
  audioSegments: SynthesizedSegmentAudio[];
  backendUsed: TtsBackend;
  sampleRate: 48000;
  fallbackHistory: Array<{ backend: TtsBackend; reason: string }>;
}

export interface WordTimingFrame {
  word: string;
  startLocalFrame: number;
  endLocalFrame: number;
}

export interface QuantizedSegmentTiming {
  segmentId: string;
  kind: SegmentKind;
  startMs: number;
  endMs: number;
  audioDurationMs: number;
  gapAfterMs: number;
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
  /** Difference between quantized frame timestamp and exact PCM millisecond timestamp */
  syncDriftMs: number;
  wordTimingsFrames: WordTimingFrame[];
}

export interface AudioTimelineResult {
  fps: Fps;
  totalDurationMs: number;
  totalFrames: number;
  maxSyncDriftMs: number;
  quantizedSegments: QuantizedSegmentTiming[];
}

export interface AudioMixCue {
  cueId: string;
  sfxSlug: SfxSlug;
  sfxFilePath: string;
  triggerMs: number;
  volumeDb?: number;
}

export interface MediaProbeResult {
  filePath: string;
  formatName: string;
  durationSec: number;
  sizeBytes: number;
  bitRate?: number;
  audioStream?: {
    codec: string;
    sampleRate: number;
    channels: number;
  };
  videoStream?: {
    codec: string;
    width: number;
    height: number;
    fps: number;
  };
}

export interface ExtractAndProbeResult {
  probe: MediaProbeResult;
  extractedPath?: string;
  extractedProbe?: MediaProbeResult;
}

export interface MixMasterAudioResult {
  masterAudioPath: string;
  sampleRate: 48000;
  channels: 2;
  totalDurationMs: number;
  totalFrames: number;
  maxSyncDriftMs: number;
  quantizedSegments: QuantizedSegmentTiming[];
  appliedSfxCount: number;
  bgmDucked: boolean;
  loudnessTargetLufs: -14;
}
