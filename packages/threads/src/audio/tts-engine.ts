import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_VOICE_ID, type VoiceId } from '../contracts/index.js';
import { resolveFfmpegBin } from './ffmpeg-mastering.js';
import {
  AUDIO_SAMPLE_RATE,
  AudioError,
  DEFAULT_TTS_TIMEOUT_MS,
  DEFAULT_VIENEU_DAEMON_URL,
  DEFAULT_VIENEU_PYTHON_BIN,
  TTS_GPU_CONCURRENCY,
  type SynthesizeVoiceOptions,
  type SynthesizeVoiceResult,
  type SynthesizedSegmentAudio,
  type TtsBackend,
  type TtsSegmentInput,
  type WordTimingMs,
} from './types.js';

const execFileAsync = promisify(execFile);

export function resolveVieneuPythonBin(): string {
  return process.env['VIENEU_PYTHON_BIN'] || DEFAULT_VIENEU_PYTHON_BIN;
}

export function resolveVieneuDaemonUrl(): string {
  return process.env['VIENEU_DAEMON_URL'] || DEFAULT_VIENEU_DAEMON_URL;
}

export class AsyncSemaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];
  readonly maxConcurrency: number;

  constructor(maxConcurrency: number = TTS_GPU_CONCURRENCY) {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.current >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.current += 1;
    try {
      return await task();
    } finally {
      this.current -= 1;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

export interface WavPcmStats {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  numSamples: number;
  durationMs: number;
}

/**
 * Parses a RIFF/WAVE PCM header to extract exact physical sample count (`numSamples`).
 * At 48,000 Hz this yields 0.02 ms timing precision.
 */
export async function readWavPcmStats(wavPath: string): Promise<WavPcmStats> {
  const buf = await readFile(wavPath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioError('ERR_TTS_SYNTHESIS_FAILED', `Invalid WAV header in "${wavPath}"`);
  }

  let sampleRate: number = AUDIO_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkDataStart + 16 <= buf.length) {
      channels = buf.readUInt16LE(chunkDataStart + 2);
      sampleRate = buf.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkDataStart + 14);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  const bytesPerFrame = Math.max(1, channels * (bitsPerSample / 8));
  const numSamples = Math.floor(dataBytes / bytesPerFrame);
  const durationMs = sampleRate > 0 ? Number(((numSamples / sampleRate) * 1000).toFixed(3)) : 0;

  return {
    sampleRate,
    channels,
    bitsPerSample,
    numSamples,
    durationMs,
  };
}

export function estimateWordTimings(text: string, durationMs: number): WordTimingMs[] {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (tokens.length === 0 || durationMs <= 0) {
    return [];
  }

  const totalChars = tokens.reduce((acc, w) => acc + Math.max(1, w.length), 0);
  let cursorMs = 0;

  return tokens.map((word) => {
    const share = (Math.max(1, word.length) / totalChars) * durationMs;
    const startMs = Number(cursorMs.toFixed(2));
    cursorMs += share;
    const endMs = Number(Math.min(durationMs, cursorMs).toFixed(2));
    return { word, startMs, endMs };
  });
}

export interface TtsBackendRequest {
  segment: TtsSegmentInput;
  voiceId: VoiceId;
  refAudioPath?: string;
  outputPath: string;
  timeoutMs: number;
}

export interface TtsBackendResponse {
  wavPath: string;
  sampleRate: 48000;
  channels: number;
  numSamples: number;
  durationMs: number;
  trimmedLeadingMs?: number;
  wordTimings?: WordTimingMs[];
}

export interface TtsBackendAdapter {
  readonly backend: TtsBackend;
  synthesize(req: TtsBackendRequest): Promise<TtsBackendResponse>;
}

/** Tier 1: Warm VieNeu-TTS v3 Turbo GPU HTTP Sidecar (concurrency locked to 1) */
export class VieneuGpuSidecarAdapter implements TtsBackendAdapter {
  readonly backend: TtsBackend = 'vieneu_gpu';
  private readonly daemonUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: { daemonUrl?: string; fetchFn?: typeof fetch }) {
    this.daemonUrl = options?.daemonUrl ?? resolveVieneuDaemonUrl();
    this.fetchFn = options?.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async synthesize(req: TtsBackendRequest): Promise<TtsBackendResponse> {
    const response = await this.fetchFn(`${this.daemonUrl}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(req.timeoutMs),
      body: JSON.stringify({
        text: req.segment.ttsText,
        voiceId: req.voiceId,
        outputPath: req.outputPath,
        refAudioPath: req.refAudioPath,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`VieNeu GPU daemon HTTP ${response.status}: ${errText || response.statusText}`);
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      wavPath?: string;
      sampleRate?: number;
      channels?: number;
      numSamples?: number;
      durationMs?: number;
      wordTimings?: WordTimingMs[];
      error?: string;
    };

    if (!payload.ok || !payload.wavPath) {
      throw new Error(payload.error || 'VieNeu GPU daemon returned invalid response');
    }

    const numSamples = payload.numSamples ?? 0;
    const durationMs =
      payload.durationMs ?? (numSamples > 0 ? Number(((numSamples / AUDIO_SAMPLE_RATE) * 1000).toFixed(3)) : 0);

    return {
      wavPath: payload.wavPath,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: payload.channels ?? 1,
      numSamples,
      durationMs,
      wordTimings:
        payload.wordTimings && payload.wordTimings.length > 0
          ? payload.wordTimings
          : estimateWordTimings(req.segment.ttsText, durationMs),
    };
  }
}

/** Tier 2: VieNeu-TTS ONNX CPU Fallback via VIENEU_PYTHON_BIN */
export class VieneuOnnxCpuAdapter implements TtsBackendAdapter {
  readonly backend: TtsBackend = 'vieneu_onnx_cpu';
  private readonly pythonBin: string;

  constructor(options?: { pythonBin?: string }) {
    this.pythonBin = options?.pythonBin ?? resolveVieneuPythonBin();
  }

  async synthesize(req: TtsBackendRequest): Promise<TtsBackendResponse> {
    await mkdir(path.dirname(req.outputPath), { recursive: true });
    const inlineScript = [
      'import os, sys',
      'from pathlib import Path',
      'os.environ.setdefault("HF_HUB_OFFLINE", "1")',
      'from vieneu import Vieneu',
      'text, voice, out_path = sys.argv[1], sys.argv[2], sys.argv[3]',
      'ref_audio = sys.argv[4] if len(sys.argv) > 4 else ""',
      'model = Vieneu(mode="v3turbo")',
      'wav = model.infer(text=text, ref_audio=ref_audio) if ref_audio and Path(ref_audio).is_file() else model.infer(text=text, voice=voice)',
      'model.save(wav, out_path)',
    ].join('; ');

    await execFileAsync(
      this.pythonBin,
      ['-c', inlineScript, req.segment.ttsText, req.voiceId, req.outputPath, req.refAudioPath ?? ''],
      {
        timeout: req.timeoutMs,
        env: { ...process.env, HF_HUB_OFFLINE: process.env['HF_HUB_OFFLINE'] ?? '1' },
      },
    );

    const stats = await readWavPcmStats(req.outputPath);
    return {
      wavPath: req.outputPath,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: stats.channels,
      numSamples: stats.numSamples,
      durationMs: stats.durationMs,
      wordTimings: estimateWordTimings(req.segment.ttsText, stats.durationMs),
    };
  }
}

/** Tier 3: Edge-TTS Fallback (vi-VN-HoaiMyNeural / vi-VN-NamMinhNeural) with MP3 -> 48kHz WAV conversion */
export class EdgeTtsFallbackAdapter implements TtsBackendAdapter {
  readonly backend: TtsBackend = 'edge_tts';
  private readonly pythonBin: string;

  constructor(options?: { pythonBin?: string }) {
    this.pythonBin = options?.pythonBin ?? resolveVieneuPythonBin();
  }

  async synthesize(req: TtsBackendRequest): Promise<TtsBackendResponse> {
    await mkdir(path.dirname(req.outputPath), { recursive: true });
    const edgeVoice =
      req.voiceId === 'vi-VN-NamMinhNeural' || req.voiceId === 'vi-VN-HoaiMyNeural'
        ? req.voiceId
        : 'vi-VN-HoaiMyNeural';

    const tmpMp3 = `${req.outputPath}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp.mp3`;
    try {
      await execFileAsync(
        this.pythonBin,
        [
          '-m',
          'edge_tts',
          '--voice',
          edgeVoice,
          '--text',
          req.segment.ttsText,
          '--write-media',
          tmpMp3,
        ],
        { timeout: req.timeoutMs },
      );

      const ffmpegBin = resolveFfmpegBin();
      await execFileAsync(
        ffmpegBin,
        [
          '-y',
          '-i',
          tmpMp3,
          '-ar',
          String(AUDIO_SAMPLE_RATE),
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          req.outputPath,
        ],
        { timeout: req.timeoutMs },
      );
    } finally {
      await rm(tmpMp3, { force: true }).catch(() => {});
    }

    const stats = await readWavPcmStats(req.outputPath);
    return {
      wavPath: req.outputPath,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: stats.channels,
      numSamples: stats.numSamples,
      durationMs: stats.durationMs,
      wordTimings: estimateWordTimings(req.segment.ttsText, stats.durationMs),
    };
  }
}

export interface TtsEngineConfig {
  adapters?: readonly TtsBackendAdapter[];
  gpuConcurrency?: number;
  daemonUrl?: string;
  pythonBin?: string;
}

export class TtsEngineService {
  private readonly adapters: readonly TtsBackendAdapter[];
  private readonly gpuSemaphore: AsyncSemaphore;

  constructor(config?: TtsEngineConfig) {
    this.gpuSemaphore = new AsyncSemaphore(config?.gpuConcurrency ?? TTS_GPU_CONCURRENCY);
    if (config?.adapters && config.adapters.length > 0) {
      this.adapters = config.adapters;
    } else {
      const resolvedDaemonUrl = (config?.daemonUrl ?? resolveVieneuDaemonUrl()).trim();
      const defaults: TtsBackendAdapter[] = [];
      if (resolvedDaemonUrl) {
        defaults.push(new VieneuGpuSidecarAdapter({ daemonUrl: resolvedDaemonUrl }));
      }
      defaults.push(
        new VieneuOnnxCpuAdapter({ pythonBin: config?.pythonBin }),
        new EdgeTtsFallbackAdapter({ pythonBin: config?.pythonBin }),
      );
      this.adapters = defaults;
    }
  }

  async synthesizeSegments(
    segments: readonly TtsSegmentInput[],
    options: SynthesizeVoiceOptions,
  ): Promise<SynthesizeVoiceResult> {
    if (segments.length === 0) {
      throw new AudioError('ERR_TTS_SYNTHESIS_FAILED', 'No segments provided for TTS synthesis');
    }

    await mkdir(options.outputDir, { recursive: true });
    const voiceId: VoiceId = options.voiceId ?? DEFAULT_VOICE_ID;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
    const fallbackHistory: Array<{ backend: TtsBackend; reason: string }> = [];
    const audioSegments: SynthesizedSegmentAudio[] = [];
    let lastBackendUsed: TtsBackend = this.adapters[0]!.backend;

    // Enforce TTS_GPU_CONCURRENCY = 1 across the batch
    await this.gpuSemaphore.run(async () => {
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i]!;
        const safeName = segment.segmentId.replace(/[^A-Za-z0-9_-]/g, '_');
        const outputPath = path.join(options.outputDir, `${String(i).padStart(2, '0')}_${safeName}.wav`);

        let synthesized: { res: TtsBackendResponse; backend: TtsBackend } | null = null;

        for (const adapter of this.adapters) {
          try {
            const res = await adapter.synthesize({
              segment,
              voiceId,
              refAudioPath: options.refAudioPath,
              outputPath,
              timeoutMs,
            });
            synthesized = { res, backend: adapter.backend };
            lastBackendUsed = adapter.backend;
            break;
          } catch (error) {
            fallbackHistory.push({
              backend: adapter.backend,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (!synthesized) {
          throw new AudioError(
            'ERR_TTS_SYNTHESIS_FAILED',
            `All TTS backends failed for segment "${segment.segmentId}"`,
            {
              retryable: true,
              details: { segmentId: segment.segmentId, fallbackHistory },
            },
          );
        }

        const { res, backend } = synthesized;
        audioSegments.push({
          segmentId: segment.segmentId,
          kind: segment.kind,
          sourceCommentId: segment.sourceCommentId,
          wavPath: res.wavPath,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: res.channels,
          numSamples: res.numSamples,
          durationMs: res.durationMs,
          trimmedLeadingMs: res.trimmedLeadingMs ?? 0,
          wordTimings:
            res.wordTimings && res.wordTimings.length > 0
              ? res.wordTimings
              : estimateWordTimings(segment.ttsText, res.durationMs),
          backendUsed: backend,
        });
      }
    });

    return {
      audioSegments,
      backendUsed: lastBackendUsed,
      sampleRate: AUDIO_SAMPLE_RATE,
      fallbackHistory,
    };
  }
}
