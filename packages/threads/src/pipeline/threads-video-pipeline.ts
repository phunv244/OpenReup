import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  DEFAULT_VOICE_ID,
  type Fps,
  type Theme,
  type VoiceId,
} from '../contracts/common.js';
import type { NormalizedThreadsPost } from '../contracts/threads-post.js';
import type { AIDirectorOutput } from '../contracts/ai-director.js';
import { AIDirectorService } from '../director/index.js';
import { TtsEngineService, type TtsBackendAdapter } from '../audio/tts-engine.js';
import { mixMasterAudio } from '../audio/ffmpeg-mastering.js';
import {
  quantizeAudioTimeline,
  resolveTriggerTimeMs,
} from '../audio/timeline-quantizer.js';
import type { AudioMixCue } from '../audio/types.js';
import { buildVideoCompositionProps } from '../remotion/builder.js';
import {
  renderPreviewStill,
  renderThreadsVideo,
  type RenderVideoResult,
} from '../remotion/renderer.js';
import {
  resolveThreadsAssetsDir,
  resolveThreadsDownloadsDir,
  resolveThreadsWorkDir,
} from '../paths.js';
import { ThreadsScraperService } from '../scraper/threads-scraper.js';

export interface RunThreadsVideoPipelineOptions {
  url?: string;
  scrapedPost?: NormalizedThreadsPost;
  jobId?: string;
  voiceId?: VoiceId;
  refAudioPath?: string;
  theme?: Theme;
  fps?: Fps;
  dimOpacity?: number;
  backgroundVideoPath?: string;
  outputPath?: string;
  previewStillPath?: string;
  maxComments?: number;
  onProgress?: (stage: string, percent: number) => void;
  ttsAdapters?: readonly TtsBackendAdapter[];
}

export interface RunThreadsVideoPipelineResult {
  jobId: string;
  videoPath: string;
  previewStillPath: string;
  masterAudioPath: string;
  totalFrames: number;
  durationSec: number;
  fps: number;
  fileSizeBytes: number;
  renderElapsedMs: number;
  totalElapsedMs: number;
  director: {
    hookLines: [string] | [string, string];
    segmentCount: number;
    estimatedCostUsd: number;
  };
}

export async function runThreadsVideoPipeline(
  options: RunThreadsVideoPipelineOptions,
): Promise<RunThreadsVideoPipelineResult> {
  const started = Date.now();
  const jobId = options.jobId ?? `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const assetsDir = resolveThreadsAssetsDir();
  const defaultRefAudioPath = path.join(assetsDir, 'voices', 'co-gai-cute.wav');
  const refAudioPath =
    options.refAudioPath ?? (existsSync(defaultRefAudioPath) ? defaultRefAudioPath : undefined);
  const theme = options.theme ?? 'dark';
  const fps = options.fps ?? 60;
  const dimOpacity = options.dimOpacity ?? 0.45;

  const workDir = resolveThreadsWorkDir(jobId);
  const outputDir = options.outputPath
    ? path.dirname(path.resolve(options.outputPath))
    : resolveThreadsDownloadsDir();
  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const notify = (stage: string, percent: number) => {
    if (options.onProgress) {
      options.onProgress(stage, Math.min(100, Math.max(0, percent)));
    }
  };

  // Stage 1: Scrape Threads Post (0% - 20%)
  notify('SCRAPING', 5);
  let post: NormalizedThreadsPost;
  if (options.scrapedPost) {
    post = options.scrapedPost;
    notify('SCRAPING', 20);
  } else if (options.url) {
    const scraperService = new ThreadsScraperService();
    try {
      const scrapeRes = await scraperService.scrapePost(options.url, { jobId });
      post = scrapeRes.post;
    } finally {
      await scraperService.close();
    }
    notify('SCRAPING', 20);
  } else {
    throw new Error('Either url or scrapedPost must be provided to runThreadsVideoPipeline');
  }

  // Stage 2: AI Director & Script Structuring (20% - 35%)
  notify('DIRECTING', 25);
  const directorService = new AIDirectorService();
  const directorScript: AIDirectorOutput = await directorService.direct(post, {
    maxComments: options.maxComments ?? 5,
    scriptId: `dir_${jobId}`,
  });
  notify('DIRECTING', 35);

  // Stage 3: Voice Synthesis via VieNeu-TTS / Edge-TTS (35% - 65%)
  notify('TTS_SYNTHESIS', 40);
  const ttsEngine = new TtsEngineService({ adapters: options.ttsAdapters });
  const ttsOutputDir = path.join(workDir, 'tts');
  await mkdir(ttsOutputDir, { recursive: true });

  const ttsResult = await ttsEngine.synthesizeSegments(directorScript.segments, {
    voiceId,
    refAudioPath,
    outputDir: ttsOutputDir,
  });
  notify('TTS_SYNTHESIS', 65);

  // Stage 4: FFmpeg Audio & SFX Mastering (65% - 75%)
  notify('AUDIO_MASTERING', 70);
  const masterAudioPath = path.join(workDir, `master_${jobId}.wav`);
  const bgmPath = path.join(assetsDir, 'bgm', 'default.wav');

  // Map audio cues accurately using quantized timeline & triggerWord wordTimings
  const sfxDir = path.join(assetsDir, 'sfx');
  const audioCues: AudioMixCue[] = [];
  const timeline = quantizeAudioTimeline(ttsResult.audioSegments, fps);

  directorScript.segments.forEach((seg, sIdx) => {
    const synthSeg = ttsResult.audioSegments[sIdx];
    const qSeg = timeline.quantizedSegments[sIdx];
    const segStartMs = qSeg?.startMs ?? 200;
    const segDurMs = synthSeg?.durationMs ?? qSeg?.audioDurationMs ?? 3000;
    const wordTimings = synthSeg?.wordTimings ?? [];

    seg.audioCues.forEach((cue) => {
      const sfxFilePath = path.resolve(sfxDir, `${cue.sfxSlug}.wav`);
      if (existsSync(sfxFilePath)) {
        const localOffsetMs = resolveTriggerTimeMs(
          cue.triggerWord,
          wordTimings,
          segDurMs,
          seg.ttsText,
        );
        audioCues.push({
          cueId: cue.cueId,
          sfxSlug: cue.sfxSlug,
          sfxFilePath,
          triggerMs: Math.max(0, Math.round(segStartMs + localOffsetMs)),
          volumeDb: cue.volumeDb,
        });
      }
    });
  });

  await mixMasterAudio({
    voiceSegments: ttsResult.audioSegments,
    audioCues,
    outputPath: masterAudioPath,
    bgmPath: existsSync(bgmPath) && statSync(bgmPath).isFile() ? bgmPath : undefined,
    fps,
  });
  notify('AUDIO_MASTERING', 75);

  // Stage 5: Build Video Composition Props (75% - 80%)
  notify('BUILD_PROPS', 78);
  const compositionProps = buildVideoCompositionProps({
    jobId,
    directorScript,
    synthesizedSegments: ttsResult.audioSegments,
    masterAudioPath,
    scrapedPost: post,
    backgroundVideoPath: options.backgroundVideoPath,
    theme,
    fps,
    dimOpacity,
  });
  notify('BUILD_PROPS', 80);

  // Stage 6: Render Still Preview & Render Full MP4 (80% - 100%)
  notify('RENDERING_PREVIEW', 82);
  const previewStillPath =
    options.previewStillPath ?? path.resolve(outputDir, `preview_${jobId}.png`);
  await renderPreviewStill(compositionProps, {
    outputPath: previewStillPath,
    frame: Math.min(60, Math.floor(compositionProps.meta.totalFrames / 2)),
  });

  notify('RENDERING_VIDEO', 85);
  const videoOutputPath =
    options.outputPath ?? path.resolve(outputDir, `videothreads_${jobId}.mp4`);

  const renderResult: RenderVideoResult = await renderThreadsVideo(compositionProps, {
    outputPath: videoOutputPath,
    onProgress: (renderPct) => {
      notify('RENDERING_VIDEO', 85 + Math.round(renderPct * 15));
    },
  });

  notify('DONE', 100);
  const totalElapsedMs = Date.now() - started;

  return {
    jobId,
    videoPath: renderResult.outputPath,
    previewStillPath,
    masterAudioPath,
    totalFrames: renderResult.totalFrames,
    durationSec: renderResult.durationSec,
    fps: renderResult.fps,
    fileSizeBytes: renderResult.fileSizeBytes,
    renderElapsedMs: renderResult.renderElapsedMs,
    totalElapsedMs,
    director: {
      hookLines: directorScript.hookLines,
      segmentCount: directorScript.segments.length,
      estimatedCostUsd: directorScript.estimatedCostUsd,
    },
  };
}
