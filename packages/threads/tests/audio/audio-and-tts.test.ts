import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIO_SAMPLE_RATE,
  AsyncSemaphore,
  TTS_GPU_CONCURRENCY,
  TtsEngineService,
  findTriggerWordOffsetMs,
  probeMedia,
  quantizeAudioTimeline,
  readWavPcmStats,
  resolveFfmpegBin,
  resolveTriggerTimeMs,
  resolveVieneuPythonBin,
  type SynthesizedSegmentAudio,
  type TtsBackendAdapter,
} from '../../src/audio/index.js';
import {
  extractAndProbeMedia,
  mixMasterAudio,
  synthesizeVoiceSegments,
} from '../../src/code-mode/index.js';

const execFileAsync = promisify(execFile);

async function generateToneWav(
  outputPath: string,
  freqHz: number,
  durationSec: number,
  sampleRate = 48000,
): Promise<void> {
  const ffmpegBin = resolveFfmpegBin();
  await execFileAsync(ffmpegBin, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freqHz}:sample_rate=${sampleRate}:duration=${durationSec}`,
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
}

describe('T3.4 VieNeu-TTS 3-Tier Fallback, Concurrency=1 & Zero-Drift Timeline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vt-audio-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads VIENEU_PYTHON_BIN from environment without hardcoding', () => {
    const prev = process.env['VIENEU_PYTHON_BIN'];
    try {
      process.env['VIENEU_PYTHON_BIN'] = '/custom/venv/bin/python3';
      expect(resolveVieneuPythonBin()).toBe('/custom/venv/bin/python3');
    } finally {
      if (prev === undefined) {
        delete process.env['VIENEU_PYTHON_BIN'];
      } else {
        process.env['VIENEU_PYTHON_BIN'] = prev;
      }
    }
  });

  it('enforces TTS_GPU_CONCURRENCY = 1 via AsyncSemaphore', async () => {
    expect(TTS_GPU_CONCURRENCY).toBe(1);
    const sem = new AsyncSemaphore(TTS_GPU_CONCURRENCY);
    let inFlight = 0;
    let maxInFlight = 0;

    await Promise.all(
      [1, 2, 3, 4].map(() =>
        sem.run(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
        }),
      ),
    );

    expect(maxInFlight).toBe(1);
  });

  it('automatically falls back across 3 tiers: VieNeu GPU (OOM) -> VieNeu ONNX CPU (timeout) -> Edge-TTS', async () => {
    const wavPath = path.join(tmpDir, 'seg0.wav');
    await generateToneWav(wavPath, 440, 0.5, AUDIO_SAMPLE_RATE);
    const stats = await readWavPcmStats(wavPath);

    const gpuFail: TtsBackendAdapter = {
      backend: 'vieneu_gpu',
      synthesize: () => Promise.reject(new Error('CUDA_OOM: out of memory')),
    };
    const onnxFail: TtsBackendAdapter = {
      backend: 'vieneu_onnx_cpu',
      synthesize: () => Promise.reject(new Error('TimeoutError: exceeded 20000ms')),
    };
    const edgeOk: TtsBackendAdapter = {
      backend: 'edge_tts',
      synthesize: () =>
        Promise.resolve({
          wavPath,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: stats.channels,
          numSamples: stats.numSamples,
          durationMs: stats.durationMs,
        }),
    };

    const engine = new TtsEngineService({ adapters: [gpuFail, onnxFail, edgeOk] });
    const result = await engine.synthesizeSegments(
      [{ segmentId: 'post_p1', kind: 'MAIN_POST', ttsText: 'Xin chào mọi người trên Threads' }],
      { voiceId: 'Adam bựa', outputDir: tmpDir },
    );

    expect(result.backendUsed).toBe('edge_tts');
    expect(result.sampleRate).toBe(48000);
    expect(result.fallbackHistory).toHaveLength(2);
    expect(result.fallbackHistory[0]?.backend).toBe('vieneu_gpu');
    expect(result.fallbackHistory[1]?.backend).toBe('vieneu_onnx_cpu');
    expect(result.audioSegments[0]?.numSamples).toBe(24000);
    expect(result.audioSegments[0]?.wordTimings.length).toBeGreaterThan(0);
  });

  it('quantizes audio timeline with zero frame gaps and <= 0.5 frame sync drift at 60fps & 30fps', () => {
    const segments: SynthesizedSegmentAudio[] = [
      {
        segmentId: 'post_p1',
        kind: 'MAIN_POST',
        wavPath: '/tmp/a.wav',
        sampleRate: 48000,
        channels: 1,
        numSamples: 57_600, // 1200ms
        durationMs: 1200,
        trimmedLeadingMs: 0,
        wordTimings: [
          { word: 'lương', startMs: 100, endMs: 350 },
          { word: 'chín', startMs: 360, endMs: 600 },
        ],
        backendUsed: 'vieneu_gpu',
      },
      {
        segmentId: 'cmt_1_p1',
        kind: 'COMMENT',
        sourceCommentId: 'c1',
        wavPath: '/tmp/b.wav',
        sampleRate: 48000,
        channels: 1,
        numSamples: 45_120, // 940ms
        durationMs: 940,
        trimmedLeadingMs: 0,
        wordTimings: [{ word: 'chạy', startMs: 50, endMs: 300 }],
        backendUsed: 'vieneu_gpu',
      },
      {
        segmentId: 'cmt_2_p1',
        kind: 'COMMENT',
        sourceCommentId: 'c2',
        wavPath: '/tmp/c.wav',
        sampleRate: 48000,
        channels: 1,
        numSamples: 73_440, // 1530ms
        durationMs: 1530,
        trimmedLeadingMs: 0,
        wordTimings: [{ word: 'toang', startMs: 200, endMs: 500 }],
        backendUsed: 'vieneu_gpu',
      },
    ];

    const t60 = quantizeAudioTimeline(segments, 60);
    expect(t60.maxSyncDriftMs).toBeLessThanOrEqual(8.34); // <= 0.5 frame @ 60fps
    expect(t60.quantizedSegments[1]?.startFrame).toBe(t60.quantizedSegments[0]?.endFrame);
    expect(t60.quantizedSegments[2]?.startFrame).toBe(t60.quantizedSegments[1]?.endFrame);

    const t30 = quantizeAudioTimeline(segments, 30);
    expect(t30.maxSyncDriftMs).toBeLessThanOrEqual(16.67); // <= 0.5 frame @ 30fps
    expect(findTriggerWordOffsetMs(segments[0]!.wordTimings, 'chín', 1200)).toBe(360);

    // Multi-word triggerWord & punctuation-insensitive matching
    const multiTimings = [
      { word: 'Sếp', startMs: 100, endMs: 300 },
      { word: 'bắt', startMs: 310, endMs: 500 },
      { word: 'tăng', startMs: 820, endMs: 1050 },
      { word: 'ca!', startMs: 1060, endMs: 1300 },
    ];
    expect(resolveTriggerTimeMs('tăng ca', multiTimings, 2000, 'Sếp bắt tăng ca!')).toBe(820);
    // Proportional fallback when wordTimings is empty
    expect(
      resolveTriggerTimeMs('cuối năm', [], 2000, 'Đi làm lương thấp nhưng cuối năm thưởng lớn'),
    ).toBeGreaterThan(800);
  });

  it('runs real FFmpeg extractAndProbeMedia, mixMasterAudio (adelay SFX + sidechaincompress BGM + loudnorm -14 LUFS) & Code Mode SDK', async () => {
    const rawVoice1 = path.join(tmpDir, 'voice1.wav');
    const rawVoice2 = path.join(tmpDir, 'voice2.wav');
    const sfxPath = path.join(tmpDir, 'pop.wav');
    const bgmRaw = path.join(tmpDir, 'bgm_22k.wav');
    const bgm48k = path.join(tmpDir, 'bgm_48k.wav');
    const masterPath = path.join(tmpDir, 'master_audio.wav');

    await Promise.all([
      generateToneWav(rawVoice1, 440, 0.8, 48000),
      generateToneWav(rawVoice2, 520, 0.7, 48000),
      generateToneWav(sfxPath, 880, 0.15, 48000),
      generateToneWav(bgmRaw, 220, 2.0, 22050),
    ]);

    // 1. Code Mode extractAndProbeMedia converts 22050Hz BGM -> 48000Hz stereo WAV
    const extracted = await extractAndProbeMedia({
      inputPath: bgmRaw,
      outputPath: bgm48k,
      trimStartSec: 0,
      trimEndSec: 1.5,
      toWav48k: true,
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.data.extractedProbe?.audioStream?.sampleRate).toBe(48000);
    expect(extracted.data.extractedProbe?.audioStream?.channels).toBe(2);

    // 2. Code Mode synthesizeVoiceSegments via injectable mock GPU adapter returning real 48kHz WAVs
    const s1 = await readWavPcmStats(rawVoice1);
    const s2 = await readWavPcmStats(rawVoice2);
    const mockGpu: TtsBackendAdapter = {
      backend: 'vieneu_gpu',
      synthesize: (req) => {
        const isFirst = req.segment.segmentId === 'post_p1';
        return Promise.resolve({
          wavPath: isFirst ? rawVoice1 : rawVoice2,
          sampleRate: 48000,
          channels: isFirst ? s1.channels : s2.channels,
          numSamples: isFirst ? s1.numSamples : s2.numSamples,
          durationMs: isFirst ? s1.durationMs : s2.durationMs,
        });
      },
    };

    const ttsRes = await synthesizeVoiceSegments({
      segments: [
        { segmentId: 'post_p1', kind: 'MAIN_POST', ttsText: 'Đoạn một thử nghiệm' },
        { segmentId: 'cmt_1_p1', kind: 'COMMENT', sourceCommentId: 'c1', ttsText: 'Đoạn hai bình luận' },
      ],
      voiceId: 'Adam bựa',
      outputDir: tmpDir,
      adapters: [mockGpu],
    });
    expect(ttsRes.ok).toBe(true);
    if (!ttsRes.ok) return;

    // 3. Code Mode mixMasterAudio (real FFmpeg adelay + amix + sidechaincompress + loudnorm -14 LUFS)
    const mixRes = await mixMasterAudio({
      voiceSegments: ttsRes.data.audioSegments,
      audioCues: [
        { cueId: 'ac_pop', sfxSlug: 'pop', sfxFilePath: sfxPath, triggerMs: 300, volumeDb: -4 },
      ],
      bgmPath: bgm48k,
      outputPath: masterPath,
      fps: 60,
    });
    expect(mixRes.ok).toBe(true);
    if (!mixRes.ok) return;

    expect(mixRes.data.sampleRate).toBe(48000);
    expect(mixRes.data.channels).toBe(2);
    expect(mixRes.data.bgmDucked).toBe(true);
    expect(mixRes.data.appliedSfxCount).toBe(1);
    expect(mixRes.data.loudnessTargetLufs).toBe(-14);
    expect(mixRes.data.maxSyncDriftMs).toBeLessThanOrEqual(8.34);

    // Probe the real generated master_audio.wav with ffprobe
    const masterProbe = await probeMedia(masterPath);
    expect(masterProbe.audioStream?.sampleRate).toBe(48000);
    expect(masterProbe.audioStream?.channels).toBe(2);
    expect(masterProbe.audioStream?.codec).toBe('pcm_s16le');
    expect(masterProbe.durationSec).toBeGreaterThan(2.0);
  });
});
