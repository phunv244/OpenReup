import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORIGINAL_AUDIO_ALIMITER_FILTER,
  buildOriginalAudioFilterChain,
  mixMasterAudio,
  probeMedia,
  resolveFfmpegBin,
  validateOriginalAudioVolumePct,
} from '../../src/audio/ffmpeg-mastering.js';
import type { TtsBackendAdapter } from '../../src/audio/tts-engine.js';
import { parseCliArgs } from '../../src/cli.js';
import {
  buildOriginalAudioDspFilter,
  extractThreadsVideo,
  runReupThreadsPipeline,
} from '../../src/code-mode/reup.js';
import { REUP_PIPELINE_STEPS, buildSrtContent, probeNvenc } from '../../src/reup/index.js';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openreup-threads-test-'));
  tempDirs.push(dir);
  return dir;
}

async function createSampleWav(outPath: string, durationSec = 0.6, freq = 440): Promise<void> {
  const ffmpeg = resolveFfmpegBin();
  await execFileAsync(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${durationSec}`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    outPath,
  ]);
}

async function createSampleMp4(outPath: string, durationSec = 1.0): Promise<void> {
  const ffmpeg = resolveFfmpegBin();
  await execFileAsync(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=navy:s=360x640:d=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=220:duration=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-shortest',
    outPath,
  ]);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Original Audio Volume DSP (0–200% + alimiter)', () => {
  it('mutes original audio track when originalAudioVolumePct === 0', () => {
    const spec = buildOriginalAudioFilterChain(0);
    expect(spec.enabled).toBe(false);
    expect(spec.amplified).toBe(false);
    expect(spec.limiterApplied).toBe(false);
    expect(spec.filterChain).toBe('');
  });

  it('scales linearly without limiter when originalAudioVolumePct is 1–100', () => {
    const spec20 = buildOriginalAudioFilterChain(20);
    expect(spec20.enabled).toBe(true);
    expect(spec20.amplified).toBe(false);
    expect(spec20.limiterApplied).toBe(false);
    expect(spec20.filterChain).toBe('volume=0.200');

    const spec100 = buildOriginalAudioFilterChain(100);
    expect(spec100.enabled).toBe(true);
    expect(spec100.amplified).toBe(false);
    expect(spec100.limiterApplied).toBe(false);
    expect(spec100.filterChain).toBe('volume=1.000');
  });

  it('amplifies and chains exact alimiter when originalAudioVolumePct is 101–200', () => {
    const spec150 = buildOriginalAudioFilterChain(150);
    expect(spec150.enabled).toBe(true);
    expect(spec150.amplified).toBe(true);
    expect(spec150.limiterApplied).toBe(true);
    expect(spec150.filterChain).toBe(`volume=1.500,${ORIGINAL_AUDIO_ALIMITER_FILTER}`);

    const spec200 = buildOriginalAudioFilterChain(200);
    expect(spec200.limiterApplied).toBe(true);
    expect(spec200.filterChain).toBe(`volume=2.000,${ORIGINAL_AUDIO_ALIMITER_FILTER}`);
  });

  it('rejects out-of-bounds values with ERR_VALIDATION_FAILED', async () => {
    expect(() => validateOriginalAudioVolumePct(-1)).toThrow(/originalAudioVolumePct/);
    expect(() => validateOriginalAudioVolumePct(201)).toThrow(/originalAudioVolumePct/);
    expect(() => validateOriginalAudioVolumePct(Number.NaN)).toThrow(/originalAudioVolumePct/);

    const negRes = await buildOriginalAudioDspFilter({ originalAudioVolumePct: -5 });
    expect(negRes.ok).toBe(false);
    if (!negRes.ok) expect(negRes.error.code).toBe('ERR_VALIDATION_FAILED');

    const overRes = await buildOriginalAudioDspFilter({ originalAudioVolumePct: 250 });
    expect(overRes.ok).toBe(false);
    if (!overRes.ok) expect(overRes.error.code).toBe('ERR_VALIDATION_FAILED');
  });

  it('mixMasterAudio succeeds with originalAudioVolumePct 0, 20, and 150 at 48kHz -14 LUFS', async () => {
    const dir = await makeTempDir();
    const voiceWav = path.join(dir, 'voice.wav');
    const origWav = path.join(dir, 'orig.wav');
    await createSampleWav(voiceWav, 0.5, 440);
    await createSampleWav(origWav, 0.8, 220);

    for (const pct of [0, 20, 150]) {
      const out = path.join(dir, `master_${pct}.wav`);
      const res = await mixMasterAudio({
        voiceSegments: [
          {
            segmentId: 'seg-1',
            kind: 'MAIN_POST',
            wavPath: voiceWav,
            sampleRate: 48_000,
            channels: 2,
            numSamples: 24_000,
            durationMs: 500,
            trimmedLeadingMs: 0,
            wordTimings: [],
            backendUsed: 'vieneu_onnx_cpu',
          },
        ],
        originalAudioPath: origWav,
        originalAudioVolumePct: pct,
        outputPath: out,
        fps: 30,
      });
      expect(existsSync(out)).toBe(true);
      expect(res.sampleRate).toBe(48_000);
      expect(res.loudnessTargetLufs).toBe(-14);
    }
  });
});

describe('ReupThreads 6-step pipeline & helpers', () => {
  it('validates originalAudioVolumePct out of bounds in runReupThreadsPipeline', async () => {
    const res = await runReupThreadsPipeline({
      localVideoPath: '/tmp/nonexistent.mp4',
      originalAudioVolumePct: 205,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ERR_VALIDATION_FAILED');
  });

  it('runs full 6-step pipeline sequentially with checkpoint, delogo, subcover, burnSub, and 150% limiter', async () => {
    const dir = await makeTempDir();
    const inputMp4 = path.join(dir, 'input.mp4');
    const outputMp4 = path.join(dir, 'out_reup.mp4');
    const workDir = path.join(dir, 'work');
    await createSampleMp4(inputMp4, 1.0);

    const fakeAdapter: TtsBackendAdapter = {
      backend: 'vieneu_onnx_cpu',
      async synthesize(req) {
        await createSampleWav(req.outputPath, 0.6, 520);
        return {
          wavPath: req.outputPath,
          sampleRate: 48_000,
          channels: 2,
          numSamples: 28_800,
          durationMs: 600,
        };
      },
    };

    const progressSteps: string[] = [];
    const res = await runReupThreadsPipeline({
      localVideoPath: inputMp4,
      jobId: 'reup_test_01',
      workDir,
      outputPath: outputMp4,
      originalAudioVolumePct: 150,
      delogo: '10,10,40,40',
      subcover: '10,500,300,60',
      burnSub: true,
      skipAgy: true,
      encoder: 'cpu',
      segments: [{ id: 1, startSec: 0, endSec: 0.9, sourceText: 'Xin chào Threads Reup' }],
      ttsAdapters: [fakeAdapter],
      onProgress: (step) => {
        if (!progressSteps.includes(step)) progressSteps.push(step);
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.stepsCompleted).toEqual([...REUP_PIPELINE_STEPS]);
      expect(progressSteps).toEqual([...REUP_PIPELINE_STEPS]);
      expect(res.data.originalAudioVolumePct).toBe(150);
      expect(res.data.limiterApplied).toBe(true);
      expect(res.data.loudnessTargetLufs).toBe(-14);
      expect(existsSync(res.data.outputVideoPath)).toBe(true);
      expect(existsSync(res.data.checkpointPath)).toBe(true);
      const probed = await probeMedia(res.data.outputVideoPath);
      expect(probed.videoStream?.width).toBe(360);
      expect(probed.audioStream?.sampleRate).toBe(48_000);
    }
  });

  it('extractThreadsVideo rejects invalid URL with ERR_INVALID_URL', async () => {
    const res = await extractThreadsVideo({ url: 'https://example.com/not-threads' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ERR_INVALID_URL');
  });

  it('probeNvenc returns structured encoder result without throwing', async () => {
    const result = await probeNvenc({ force: true });
    expect(['h264_nvenc', 'libx264']).toContain(result.encoder);
    expect(typeof result.available).toBe('boolean');
  });

  it('buildSrtContent and parseCliArgs produce valid outputs', () => {
    const srt = buildSrtContent([
      { id: 1, startSec: 0, endSec: 1.5, sourceText: 'hello', adaptedText: 'xin chào' },
    ]);
    expect(srt).toContain('00:00:00,000 --> 00:00:01,500');
    expect(srt).toContain('xin chào');

    const parsed = parseCliArgs([
      'reup-threads',
      '--url',
      'https://www.threads.net/@u/post/abc',
      '--original-audio-volume-pct',
      '150',
    ]);
    expect(parsed.command).toBe('reup-threads');
    expect(parsed.flags['original-audio-volume-pct']).toBe('150');
  });

  it('resolves Remotion entryPoint, assets, and work/output paths independently of process.cwd()', async () => {
    const {
      THREADS_PKG_ROOT,
      resolveRemotionEntryPoint,
      resolveRemotionPublicDir,
      resolveThreadsAssetsDir,
      resolveThreadsWorkDir,
      resolveThreadsDownloadsDir,
    } = await import('../../src/paths.js');
    const { buildVideoCompositionProps } = await import('../../src/remotion/builder.js');

    const prevCwd = process.cwd();
    const foreignCwd = await makeTempDir();
    try {
      process.chdir(foreignCwd);

      const entryPoint = resolveRemotionEntryPoint();
      expect(entryPoint).toBe(path.resolve(THREADS_PKG_ROOT, 'src', 'remotion', 'index.ts'));
      expect(existsSync(entryPoint)).toBe(true);

      const assetsDir = resolveThreadsAssetsDir();
      expect(assetsDir).toBe(path.join(THREADS_PKG_ROOT, 'assets'));

      const workDir = resolveThreadsWorkDir('cwd_test_job');
      const dlDir = resolveThreadsDownloadsDir();
      expect(workDir.startsWith(foreignCwd)).toBe(false);
      expect(dlDir.startsWith(foreignCwd)).toBe(false);

      const props = buildVideoCompositionProps({
        jobId: 'cwd_test_job',
        directorScript: {
          id: 'dir_cwd_test',
          postId: 'post_cwd',
          modelName: 'deterministic-rule-director-v1',
          hookLines: ['TEST CWD'],
          selectedCommentIds: [],
          segments: [
            {
              segmentId: 'seg_1',
              kind: 'MAIN_POST',
              authorHandle: 'tester',
              displayText: 'Chạy từ thư mục khác vẫn tìm đúng assets và Remotion entryPoint',
              ttsText: 'Chạy từ thư mục khác',
              imageIndexes: [],
              audioCues: [],
              visualCues: [],
            },
          ],
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
          createdAt: 1764176400,
        },
        synthesizedSegments: [
          {
            segmentId: 'seg_1',
            kind: 'MAIN_POST',
            wavPath: path.join(foreignCwd, 'v1.wav'),
            durationMs: 1200,
            numSamples: 57_600,
            sampleRate: 48_000,
            channels: 2,
            trimmedLeadingMs: 0,
            wordTimings: [],
            backendUsed: 'vieneu_onnx_cpu',
          },
        ],
        masterAudioPath: path.join(workDir, 'master_cwd_test_job.wav'),
        fps: 60,
        theme: 'dark',
      });

      const publicDir = resolveRemotionPublicDir();
      expect(props.background.videoSrc).toBe(
        path.relative(publicDir, path.join(assetsDir, 'gameplay', 'default.mp4')).split(path.sep).join('/'),
      );
      expect(existsSync(path.join(foreignCwd, 'output'))).toBe(false);
      expect(existsSync(path.join(foreignCwd, '.cache'))).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('blocks SSRF (private IP / non-CDN host), 3xx redirects, and oversized video downloads in extractThreadsVideo', async () => {
    const dir = await makeTempDir();
    const makeSsrHtml = (videoUrl: string) =>
      `<html><script type="application/json" data-sjs>${JSON.stringify({
        require: [
          [
            'ScheduledServerJS',
            'handle',
            null,
            [
              {
                __bbox: {
                  result: {
                    data: {
                      data: {
                        edges: [
                          {
                            node: {
                              thread_items: [
                                {
                                  post: {
                                    pk: 'root-ssrf',
                                    code: 'SSRF123',
                                    user: { username: 'tester' },
                                    caption: { text: 'test' },
                                    media_type: 2,
                                    video_versions: [{ url: videoUrl, width: 720, height: 1280 }],
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            ],
          ],
        ],
      })}</script></html>`;

    // 1) Private IP / non-CDN URL must be blocked BEFORE fetchFn is called for videoUrl
    const fetchedUrls: string[] = [];
    const ssrfRes = await extractThreadsVideo({
      url: 'https://www.threads.net/@tester/post/SSRF123',
      outputDir: dir,
      enableTier2Fallback: false,
      fetchFn: async (input) => {
        const u = String(input);
        fetchedUrls.push(u);
        return new Response(makeSsrHtml('https://169.254.169.254/latest/meta-data'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    expect(ssrfRes.ok).toBe(false);
    if (!ssrfRes.ok) {
      expect(ssrfRes.error.code).toBe('ERR_VALIDATION_FAILED');
      expect(ssrfRes.error.message).toContain('SSRF_BLOCKED');
    }
    expect(fetchedUrls.some((u) => u.includes('169.254.169.254'))).toBe(false);

    // 2) 302 redirect from allowed CDN must be blocked (redirect: 'manual')
    const redirectRes = await extractThreadsVideo({
      url: 'https://www.threads.net/@tester/post/SSRF123',
      outputDir: dir,
      enableTier2Fallback: false,
      serviceConfig: { verifyDns: false },
      fetchFn: async (input, init) => {
        const u = String(input);
        if (u.includes('threads.net')) {
          return new Response(makeSsrHtml('https://scontent.cdninstagram.com/v/test.mp4'), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        expect(init?.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/secret' },
        });
      },
    });
    expect(redirectRes.ok).toBe(false);
    if (!redirectRes.ok) {
      expect(redirectRes.error.code).toBe('ERR_REUP_INGEST_FAILED');
      expect(redirectRes.error.message).toContain('SSRF_BLOCKED');
    }

    // 3) Oversized video download must be rejected before buffering into memory
    const bigRes = await extractThreadsVideo({
      url: 'https://www.threads.net/@tester/post/SSRF123',
      outputDir: dir,
      enableTier2Fallback: false,
      maxDownloadBytes: 128,
      serviceConfig: { verifyDns: false },
      fetchFn: async (input) => {
        const u = String(input);
        if (u.includes('threads.net')) {
          return new Response(makeSsrHtml('https://scontent.cdninstagram.com/v/big.mp4'), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response(new Uint8Array(512), {
          status: 200,
          headers: { 'content-length': '512' },
        });
      },
    });
    expect(bigRes.ok).toBe(false);
    if (!bigRes.ok) {
      expect(bigRes.error.code).toBe('ERR_REUP_INGEST_FAILED');
      expect(bigRes.error.message).toContain('exceeds maximum allowed size');
    }
  });

  it('rejects fontName FFmpeg filter injection payloads with ERR_VALIDATION_FAILED', async () => {
    for (const malicious of [
      "Arial',drawbox=x=0:y=0:w=100:h=100:color=red",
      'Font:Bold=1',
      'Font;rm -rf /',
    ]) {
      const res = await runReupThreadsPipeline({
        localVideoPath: '/tmp/nonexistent.mp4',
        fontName: malicious,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('ERR_VALIDATION_FAILED');
      }
    }
  });
});
