import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Fps } from '../contracts/index.js';
import { resolveLocalBinary } from '../paths.js';
import { quantizeAudioTimeline } from './timeline-quantizer.js';
import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  AudioError,
  type AudioMixCue,
  type ExtractAndProbeResult,
  type MediaProbeResult,
  type MixMasterAudioResult,
  type SynthesizedSegmentAudio,
} from './types.js';

const execFileAsync = promisify(execFile);

export const ORIGINAL_AUDIO_VOLUME_MIN = 0 as const;
export const ORIGINAL_AUDIO_VOLUME_MAX = 200 as const;
export const ORIGINAL_AUDIO_ALIMITER_FILTER =
  'alimiter=limit=0.891:attack=5:release=50:level=disabled' as const;

export interface OriginalAudioFilterSpec {
  volumePct: number;
  enabled: boolean;
  amplified: boolean;
  gain: number;
  limiterApplied: boolean;
  filterChain: string;
}

export function validateOriginalAudioVolumePct(value: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < ORIGINAL_AUDIO_VOLUME_MIN ||
    value > ORIGINAL_AUDIO_VOLUME_MAX
  ) {
    throw new AudioError(
      'ERR_VALIDATION_FAILED',
      `originalAudioVolumePct must be a finite number between ${ORIGINAL_AUDIO_VOLUME_MIN} and ${ORIGINAL_AUDIO_VOLUME_MAX} (received ${String(value)})`,
      { details: { field: 'originalAudioVolumePct', value, min: 0, max: 200 } },
    );
  }
  return value;
}

export function buildOriginalAudioFilterChain(
  originalAudioVolumePct: number,
): OriginalAudioFilterSpec {
  const volumePct = validateOriginalAudioVolumePct(originalAudioVolumePct);
  if (volumePct === 0) {
    return {
      volumePct: 0,
      enabled: false,
      amplified: false,
      gain: 0,
      limiterApplied: false,
      filterChain: '',
    };
  }
  const gain = Number((volumePct / 100).toFixed(4));
  if (volumePct > 100) {
    return {
      volumePct,
      enabled: true,
      amplified: true,
      gain,
      limiterApplied: true,
      filterChain: `volume=${gain.toFixed(3)},${ORIGINAL_AUDIO_ALIMITER_FILTER}`,
    };
  }
  return {
    volumePct,
    enabled: true,
    amplified: false,
    gain,
    limiterApplied: false,
    filterChain: `volume=${gain.toFixed(3)}`,
  };
}

export function resolveFfmpegBin(): string {
  return resolveLocalBinary('ffmpeg', ['FFMPEG_BIN', 'REUP_FFMPEG']);
}

export function resolveFfprobeBin(): string {
  return resolveLocalBinary('ffprobe', ['FFPROBE_BIN', 'REUP_FFPROBE']);
}

interface RawFfprobeJson {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    width?: number;
    height?: number;
    r_frame_rate?: string;
  }>;
}

function parseFrameRate(raw?: string): number {
  if (!raw) return 0;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(2));
    }
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function probeMedia(
  inputPath: string,
  options?: { ffprobeBin?: string; timeoutMs?: number },
): Promise<MediaProbeResult> {
  const ffprobeBin = options?.ffprobeBin ?? resolveFfprobeBin();
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
      { timeout: options?.timeoutMs ?? 15_000 },
    );

    const parsed = JSON.parse(stdout) as RawFfprobeJson;
    const format = parsed.format ?? {};
    const streams = parsed.streams ?? [];

    const audio = streams.find((s) => s.codec_type === 'audio');
    const video = streams.find((s) => s.codec_type === 'video');

    return {
      filePath: inputPath,
      formatName: format.format_name ?? 'unknown',
      durationSec: Number(Number(format.duration ?? 0).toFixed(4)),
      sizeBytes: Number(format.size ?? 0),
      bitRate: format.bit_rate ? Number(format.bit_rate) : undefined,
      audioStream: audio
        ? {
            codec: audio.codec_name ?? 'unknown',
            sampleRate: Number(audio.sample_rate ?? 0),
            channels: audio.channels ?? 0,
          }
        : undefined,
      videoStream: video
        ? {
            codec: video.codec_name ?? 'unknown',
            width: video.width ?? 0,
            height: video.height ?? 0,
            fps: parseFrameRate(video.r_frame_rate),
          }
        : undefined,
    };
  } catch (error) {
    throw new AudioError(
      'ERR_RENDER_FAILED',
      `Failed to probe media "${inputPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { inputPath } },
    );
  }
}

export interface ExtractAndProbeOptions {
  inputPath: string;
  outputPath?: string;
  trimStartSec?: number;
  trimEndSec?: number;
  toWav48k?: boolean;
  ffmpegBin?: string;
  ffprobeBin?: string;
  timeoutMs?: number;
}

/**
 * Probes an audio/video asset via `ffprobe` and optionally trims/extracts it to
 * 48,000 Hz stereo 16-bit PCM WAV using the local FFmpeg binary.
 */
export async function extractAndProbeMedia(
  options: ExtractAndProbeOptions,
): Promise<ExtractAndProbeResult> {
  const probe = await probeMedia(options.inputPath, {
    ffprobeBin: options.ffprobeBin,
    timeoutMs: options.timeoutMs,
  });

  const shouldExtract =
    Boolean(options.outputPath) ||
    options.toWav48k === true ||
    options.trimStartSec !== undefined ||
    options.trimEndSec !== undefined;

  if (!shouldExtract) {
    return { probe };
  }

  const outPath =
    options.outputPath ??
    path.join(
      path.dirname(options.inputPath),
      `${path.basename(options.inputPath, path.extname(options.inputPath))}_48k.wav`,
    );

  await mkdir(path.dirname(outPath), { recursive: true });
  const ffmpegBin = options.ffmpegBin ?? resolveFfmpegBin();
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];

  if (options.trimStartSec !== undefined && options.trimStartSec > 0) {
    args.push('-ss', String(options.trimStartSec));
  }
  args.push('-i', options.inputPath);
  if (options.trimEndSec !== undefined && options.trimEndSec > 0) {
    const duration =
      options.trimStartSec !== undefined
        ? Math.max(0.05, options.trimEndSec - options.trimStartSec)
        : options.trimEndSec;
    args.push('-t', String(duration));
  }

  args.push(
    '-vn',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    String(AUDIO_CHANNELS),
    '-c:a',
    'pcm_s16le',
    outPath,
  );

  try {
    await execFileAsync(ffmpegBin, args, { timeout: options.timeoutMs ?? 60_000 });
  } catch (error) {
    throw new AudioError(
      'ERR_RENDER_FAILED',
      `FFmpeg extract failed for "${options.inputPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { inputPath: options.inputPath, outPath } },
    );
  }

  const extractedProbe = await probeMedia(outPath, {
    ffprobeBin: options.ffprobeBin,
    timeoutMs: options.timeoutMs,
  });

  return {
    probe,
    extractedPath: outPath,
    extractedProbe,
  };
}

export interface MixMasterAudioOptions {
  voiceSegments: readonly SynthesizedSegmentAudio[];
  audioCues?: readonly AudioMixCue[];
  bgmPath?: string;
  originalAudioPath?: string;
  originalAudioVolumePct?: number;
  outputPath: string;
  fps: Fps;
  bgmVolumeDb?: number;
  ffmpegBin?: string;
  timeoutMs?: number;
}

/**
 * Single-pass FFmpeg Native Audio Mastering (`ARCHITECTURE.md` 5.3):
 * 1. Places 48kHz voice segments at exact quantized/cumulative millisecond offsets (`adelay` + `amix`) -> `[voice_bus]`
 * 2. Places SFX cues (`whoosh`, `pop`, `vine_boom`, `laughter`, `ding`) via `adelay` + `volume` -> `[sfx_bus]`
 * 3. Ducks looping BGM via `sidechaincompress` triggered by `[voice_bus]` -> `[ducked_bgm]`
 * 4. Optional original video audio (`0–200%`):
 *    - `0`: muted (not included)
 *    - `1–100`: linear scale + `sidechaincompress` ducking
 *    - `101–200`: amplify + `alimiter=limit=0.891:attack=5:release=50:level=disabled` + ducking
 * 5. Sums all buses and applies EBU R128 `loudnorm=I=-14:TP=-1.0:LRA=11` -> 48kHz stereo 16-bit PCM `master_audio.wav`
 */
export async function mixMasterAudio(
  options: MixMasterAudioOptions,
): Promise<MixMasterAudioResult> {
  if (options.voiceSegments.length === 0) {
    throw new AudioError('ERR_TTS_SYNTHESIS_FAILED', 'Cannot mix master audio with 0 voice segments');
  }

  const origSpec =
    options.originalAudioVolumePct !== undefined
      ? buildOriginalAudioFilterChain(options.originalAudioVolumePct)
      : null;

  const timeline = quantizeAudioTimeline(options.voiceSegments, options.fps);
  const totalDurationSec = Number((timeline.totalDurationMs / 1000).toFixed(4));
  const cues = options.audioCues ?? [];
  const hasBgm = Boolean(options.bgmPath);
  const hasOriginalAudio = Boolean(options.originalAudioPath && origSpec?.enabled);

  await mkdir(path.dirname(options.outputPath), { recursive: true });

  const inputArgs: string[] = [];
  const filterChains: string[] = [];
  let inputIndex = 0;

  // 1. Voice segment inputs + adelay placement
  const voiceLabels: string[] = [];
  for (let i = 0; i < options.voiceSegments.length; i += 1) {
    const seg = options.voiceSegments[i]!;
    const timing = timeline.quantizedSegments[i]!;
    const delayMs = Math.max(0, Math.round(timing.startMs));

    inputArgs.push('-i', seg.wavPath);
    const label = `[v${i}]`;
    filterChains.push(
      `[${inputIndex}:a]aresample=${AUDIO_SAMPLE_RATE},aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,adelay=${delayMs}|${delayMs}${label}`,
    );
    voiceLabels.push(label);
    inputIndex += 1;
  }

  if (voiceLabels.length === 1) {
    filterChains.push(`${voiceLabels[0]}apad=whole_dur=${totalDurationSec}[voice_raw]`);
  } else {
    filterChains.push(
      `${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_dur=${totalDurationSec}[voice_raw]`,
    );
  }

  // Split voice_bus for sidechain ducking (BGM and/or Original Audio)
  const scTargets = (hasBgm ? 1 : 0) + (hasOriginalAudio ? 1 : 0);
  if (scTargets === 2) {
    filterChains.push('[voice_raw]asplit=3[voice_mix][voice_sc_bgm][voice_sc_orig]');
  } else if (scTargets === 1) {
    const scLabel = hasBgm ? '[voice_sc_bgm]' : '[voice_sc_orig]';
    filterChains.push(`[voice_raw]asplit=2[voice_mix]${scLabel}`);
  } else {
    filterChains.push('[voice_raw]anull[voice_mix]');
  }

  // 2. SFX cues via adelay + volume
  const sfxLabels: string[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const delayMs = Math.max(0, Math.round(cue.triggerMs));
    const volDb = cue.volumeDb ?? -4;

    inputArgs.push('-i', cue.sfxFilePath);
    const label = `[s${i}]`;
    filterChains.push(
      `[${inputIndex}:a]aresample=${AUDIO_SAMPLE_RATE},aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume=${volDb}dB,adelay=${delayMs}|${delayMs}${label}`,
    );
    sfxLabels.push(label);
    inputIndex += 1;
  }

  let hasSfxBus = false;
  if (sfxLabels.length === 1) {
    filterChains.push(`${sfxLabels[0]}anull[sfx_bus]`);
    hasSfxBus = true;
  } else if (sfxLabels.length > 1) {
    filterChains.push(
      `${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=longest:dropout_transition=0:normalize=0[sfx_bus]`,
    );
    hasSfxBus = true;
  }

  // 3. BGM loop + sidechaincompress ducking
  if (hasBgm && options.bgmPath) {
    const bgmBaseDb = options.bgmVolumeDb ?? -16;
    inputArgs.push('-stream_loop', '-1', '-i', options.bgmPath);
    filterChains.push(
      `[${inputIndex}:a]aresample=${AUDIO_SAMPLE_RATE},aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,atrim=0:${totalDurationSec},volume=${bgmBaseDb}dB[bgm_pre]`,
    );
    filterChains.push(
      `[bgm_pre][voice_sc_bgm]sidechaincompress=threshold=0.02:ratio=6:attack=25:release=350:makeup=1[ducked_bgm]`,
    );
    inputIndex += 1;
  }

  // 4. Optional original audio track (0–200% + alimiter when >100% + sidechain ducking)
  if (hasOriginalAudio && options.originalAudioPath && origSpec) {
    inputArgs.push('-i', options.originalAudioPath);
    filterChains.push(
      `[${inputIndex}:a]aresample=${AUDIO_SAMPLE_RATE},aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,apad=whole_dur=${totalDurationSec},atrim=0:${totalDurationSec},${origSpec.filterChain}[orig_pre]`,
    );
    filterChains.push(
      `[orig_pre][voice_sc_orig]sidechaincompress=threshold=0.02:ratio=4:attack=20:release=300:makeup=1[ducked_orig]`,
    );
    inputIndex += 1;
  }

  // 5. Final mix + loudnorm -14 LUFS
  const finalInputs: string[] = ['[voice_mix]'];
  if (hasSfxBus) {
    finalInputs.push('[sfx_bus]');
  }
  if (hasBgm) {
    finalInputs.push('[ducked_bgm]');
  }
  if (hasOriginalAudio) {
    finalInputs.push('[ducked_orig]');
  }

  if (finalInputs.length === 1) {
    filterChains.push(
      `[voice_mix]atrim=0:${totalDurationSec},loudnorm=I=-14:TP=-1.0:LRA=11[master_out]`,
    );
  } else {
    filterChains.push(
      `${finalInputs.join('')}amix=inputs=${finalInputs.length}:duration=first:dropout_transition=0:normalize=0,atrim=0:${totalDurationSec},loudnorm=I=-14:TP=-1.0:LRA=11[master_out]`,
    );
  }

  const ffmpegBin = options.ffmpegBin ?? resolveFfmpegBin();
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputArgs,
    '-filter_complex',
    filterChains.join(';'),
    '-map',
    '[master_out]',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    String(AUDIO_CHANNELS),
    '-c:a',
    'pcm_s16le',
    options.outputPath,
  ];

  try {
    await execFileAsync(ffmpegBin, args, { timeout: options.timeoutMs ?? 60_000 });
  } catch (error) {
    throw new AudioError(
      'ERR_RENDER_FAILED',
      `FFmpeg master audio mix failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { outputPath: options.outputPath } },
    );
  }

  return {
    masterAudioPath: options.outputPath,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: AUDIO_CHANNELS,
    totalDurationMs: timeline.totalDurationMs,
    totalFrames: timeline.totalFrames,
    maxSyncDriftMs: timeline.maxSyncDriftMs,
    quantizedSegments: timeline.quantizedSegments,
    appliedSfxCount: cues.length,
    bgmDucked: hasBgm,
    loudnessTargetLufs: -14,
  };
}
