import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildOriginalAudioFilterChain,
  extractAndProbeMedia,
  mixMasterAudio,
  probeMedia,
  resolveFfmpegBin,
  resolveFfprobeBin,
  validateOriginalAudioVolumePct,
} from '../audio/ffmpeg-mastering.js';
import { TtsEngineService } from '../audio/tts-engine.js';
import { DEFAULT_VOICE_ID } from '../contracts/common.js';
import {
  resolveOpenReupDataDir,
  resolveOpenReupFontsDir,
  resolveThreadsDownloadsDir,
} from '../paths.js';
import { ReupError } from './errors.js';
import { extractThreadsVideo } from './extractor.js';
import { probeNvenc } from './nvenc.js';
import {
  DEFAULT_MAX_REUP_DURATION_SEC,
  REGION_PATTERN,
  SAFE_FONT_NAME_PATTERN,
  type ReupCheckpoint,
  type ReupPipelineStep,
  type ReupTranscriptSegment,
  type RunReupThreadsPipelineOptions,
  type RunReupThreadsPipelineResult,
} from './types.js';

const execFileAsync = promisify(execFile);

function formatSrtTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function buildSrtContent(segments: readonly ReupTranscriptSegment[]): string {
  return segments
    .map((seg, idx) => {
      const text = (seg.adaptedText ?? seg.sourceText).trim();
      return `${idx + 1}\n${formatSrtTimestamp(seg.startSec)} --> ${formatSrtTimestamp(seg.endSec)}\n${text}\n`;
    })
    .join('\n');
}

function escapeFfmpegPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function parseRegion(raw?: string): { x: number; y: number; w: number; h: number } | null {
  if (!raw || raw === 'none') return null;
  const match = REGION_PATTERN.exec(raw.trim());
  if (!match) {
    throw new ReupError('ERR_VALIDATION_FAILED', `Invalid region format "${raw}" (expected "x,y,w,h" or "none")`, {
      details: { raw },
    });
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    w: Number(match[3]),
    h: Number(match[4]),
  };
}

export function validateFontName(fontName?: string): string | undefined {
  if (fontName === undefined || fontName === '') return undefined;
  const clean = fontName.trim();
  if (!SAFE_FONT_NAME_PATTERN.test(clean)) {
    throw new ReupError(
      'ERR_VALIDATION_FAILED',
      `Invalid fontName "${fontName}" (must match ${SAFE_FONT_NAME_PATTERN.source})`,
      { details: { field: 'fontName', fontName } },
    );
  }
  return clean;
}

async function loadCheckpoint(checkpointPath: string, jobId: string): Promise<ReupCheckpoint> {
  if (existsSync(checkpointPath)) {
    try {
      const raw = await readFile(checkpointPath, 'utf8');
      const parsed = JSON.parse(raw) as ReupCheckpoint;
      if (parsed && parsed.jobId === jobId && Array.isArray(parsed.completedSteps)) {
        return parsed;
      }
    } catch {
      // Ignore corrupt checkpoint and start clean
    }
  }
  return {
    jobId,
    completedSteps: [],
    updatedAt: new Date().toISOString(),
  };
}

async function saveCheckpoint(checkpointPath: string, cp: ReupCheckpoint): Promise<void> {
  cp.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, JSON.stringify(cp, null, 2), 'utf8');
}

function markStep(cp: ReupCheckpoint, step: ReupPipelineStep): void {
  if (!cp.completedSteps.includes(step)) {
    cp.completedSteps.push(step);
  }
}

async function adaptSegmentsWithAgyCli(
  segments: readonly ReupTranscriptSegment[],
  options: { agyBin?: string; agyModel?: string; skipAgy?: boolean },
): Promise<ReupTranscriptSegment[]> {
  if (options.skipAgy) {
    return segments.map((s) => ({ ...s, adaptedText: s.adaptedText ?? s.sourceText }));
  }

  const agyBin = options.agyBin ?? process.env['AGY_BIN'] ?? 'agy';
  const prompt = [
    'Chuyển ngữ/viết lại tự nhiên sang tiếng Việt ngắn gọn để lồng tiếng video dọc Threads.',
    'Trả về DUY NHẤT JSON array cùng số phần tử: [{"id":1,"adaptedText":"..."}].',
    JSON.stringify(segments.map((s) => ({ id: s.id, text: s.sourceText }))),
  ].join('\n');

  const args = options.agyModel ? ['--model', options.agyModel, prompt] : [prompt];
  try {
    const { stdout } = await execFileAsync(agyBin, args, { timeout: 60_000 });
    const jsonMatch = stdout.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ id: number; adaptedText?: string }>;
      const byId = new Map(parsed.map((item) => [item.id, item.adaptedText?.trim()]));
      return segments.map((s) => ({
        ...s,
        adaptedText: byId.get(s.id) || s.adaptedText || s.sourceText,
      }));
    }
  } catch {
    // Graceful fallback when agy CLI is absent or offline
  }

  return segments.map((s) => ({ ...s, adaptedText: s.adaptedText ?? s.sourceText }));
}

export async function runReupThreadsPipeline(
  options: RunReupThreadsPipelineOptions,
): Promise<RunReupThreadsPipelineResult> {
  const startedAt = Date.now();

  if (!options.url && !options.localVideoPath) {
    throw new ReupError(
      'ERR_VALIDATION_FAILED',
      'Either url or localVideoPath must be provided to runReupThreadsPipeline',
    );
  }

  // Strict 0–200 validation upfront -> ERR_VALIDATION_FAILED
  const originalAudioVolumePct = validateOriginalAudioVolumePct(
    options.originalAudioVolumePct ?? 20,
  );
  const origFilterSpec = buildOriginalAudioFilterChain(originalAudioVolumePct);

  // Validate delogo/subcover regions and fontName upfront
  const delogoBox = parseRegion(options.delogo);
  const subcoverBox = parseRegion(options.subcover);
  const safeFontName = validateFontName(options.fontName);

  const jobId = options.jobId ?? `reup_threads_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_MAX_REUP_DURATION_SEC;
  const workDir =
    options.workDir ?? path.join(resolveOpenReupDataDir(), 'threads_work', jobId);
  const checkpointPath = path.join(workDir, 'checkpoint.json');
  const downloadsDir = resolveThreadsDownloadsDir();
  const outputVideoPath =
    options.outputPath ?? path.join(downloadsDir, `${jobId}.mp4`);
  const ffmpegBin = options.ffmpegBin ?? resolveFfmpegBin();
  const ffprobeBin = options.ffprobeBin ?? resolveFfprobeBin();
  const fps = options.fps ?? 30;

  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(outputVideoPath), { recursive: true });

  const cp = await loadCheckpoint(checkpointPath, jobId);
  const notify = (step: ReupPipelineStep, pct: number, label: string) => {
    options.onProgress?.(step, Math.min(100, Math.max(0, pct)), label);
  };

  // STEP 1: INGEST
  notify('INGEST', 10, 'Đang tải video Threads...');
  if (!cp.completedSteps.includes('INGEST') || !cp.ingestedVideoPath || !existsSync(cp.ingestedVideoPath)) {
    if (options.localVideoPath) {
      if (!existsSync(options.localVideoPath)) {
        throw new ReupError(
          'ERR_REUP_INGEST_FAILED',
          `Local video not found: ${options.localVideoPath}`,
        );
      }
      cp.ingestedVideoPath = path.resolve(options.localVideoPath);
    } else if (options.url) {
      const extracted = await extractThreadsVideo({
        url: options.url,
        outputDir: workDir,
        maxDurationSec,
        serviceConfig: options.serviceConfig,
        fetchFn: options.fetchFn,
        ffmpegBin,
        ffprobeBin,
      });
      cp.ingestedVideoPath = extracted.localVideoPath;
      cp.shortcode = extracted.shortcode;
      cp.caption = extracted.caption;
      cp.authorHandle = extracted.authorHandle;
    }
    markStep(cp, 'INGEST');
    await saveCheckpoint(checkpointPath, cp);
  }
  const inputVideoPath = cp.ingestedVideoPath!;

  // STEP 2: PROBE
  notify('PROBE', 25, 'Đang phân tích thông số video...');
  if (!cp.completedSteps.includes('PROBE') || !cp.probe) {
    const probed = await probeMedia(inputVideoPath, { ffprobeBin });
    if (maxDurationSec > 0 && probed.durationSec > maxDurationSec) {
      throw new ReupError(
        'ERR_VIDEO_TOO_LONG',
        `Video dài ${probed.durationSec.toFixed(1)}s vượt giới hạn ${maxDurationSec}s.`,
        { details: { durationSec: probed.durationSec, maxDurationSec } },
      );
    }
    cp.probe = {
      durationSec: probed.durationSec > 0 ? probed.durationSec : 1,
      width: probed.videoStream?.width ?? 1080,
      height: probed.videoStream?.height ?? 1920,
      fps: probed.videoStream?.fps ?? fps,
      hasAudio: Boolean(probed.audioStream),
    };
    markStep(cp, 'PROBE');
    await saveCheckpoint(checkpointPath, cp);
  }

  // STEP 3: TRANSCRIBE
  notify('TRANSCRIBE', 40, 'Đang tách lời thoại...');
  if (!cp.completedSteps.includes('TRANSCRIBE') || !cp.transcript) {
    let transcript: ReupTranscriptSegment[];
    if (options.segments && options.segments.length > 0) {
      transcript = options.segments.map((s, idx) => ({ ...s, id: s.id ?? idx + 1 }));
    } else {
      const fallbackText = cp.caption?.trim() || 'Video từ Threads.';
      transcript = [
        {
          id: 1,
          startSec: 0,
          endSec: Math.max(1, cp.probe.durationSec),
          sourceText: fallbackText,
        },
      ];
    }
    cp.transcript = transcript;
    markStep(cp, 'TRANSCRIBE');
    await saveCheckpoint(checkpointPath, cp);
  }

  // STEP 4: ADAPT_SCRIPT (agy CLI checkpoint)
  notify('ADAPT_SCRIPT', 55, 'Đang biên tập lời thoại (agy checkpoint)...');
  const adaptCheckpointPath = path.join(workDir, 'adapt_script.json');
  if (!cp.completedSteps.includes('ADAPT_SCRIPT') || !cp.adaptedSegments) {
    let adapted: ReupTranscriptSegment[];
    if (options.adaptedSegments && options.adaptedSegments.length > 0) {
      adapted = options.adaptedSegments.map((s, idx) => ({
        ...s,
        id: s.id ?? idx + 1,
        adaptedText: s.adaptedText ?? s.sourceText,
      }));
    } else if (existsSync(adaptCheckpointPath)) {
      adapted = JSON.parse(await readFile(adaptCheckpointPath, 'utf8')) as ReupTranscriptSegment[];
    } else {
      adapted = await adaptSegmentsWithAgyCli(cp.transcript, {
        agyBin: options.agyBin,
        agyModel: options.agyModel,
        skipAgy: options.skipAgy,
      });
    }
    await writeFile(adaptCheckpointPath, JSON.stringify(adapted, null, 2), 'utf8');
    cp.adaptedSegments = adapted;
    markStep(cp, 'ADAPT_SCRIPT');
    await saveCheckpoint(checkpointPath, cp);
  }

  // STEP 5: DUB_AND_MASTER (TTS + FFmpeg 48kHz + 0-200% original audio DSP + alimiter + -14 LUFS)
  notify('DUB_AND_MASTER', 75, 'Đang tổng hợp giọng đọc & master âm thanh -14 LUFS...');
  const ttsDir = path.join(workDir, 'tts');
  await mkdir(ttsDir, { recursive: true });
  const masterAudioPath = path.join(workDir, `master_${jobId}.wav`);

  const ttsEngine = new TtsEngineService({ adapters: options.ttsAdapters });
  const ttsSegments = cp.adaptedSegments.map((seg) => ({
    segmentId: `reup_seg_${seg.id}`,
    kind: 'MAIN_POST' as const,
    ttsText: (seg.adaptedText ?? seg.sourceText).trim() || '...',
  }));

  const ttsResult = await ttsEngine.synthesizeSegments(ttsSegments, {
    voiceId: options.voiceId ?? DEFAULT_VOICE_ID,
    refAudioPath: options.refAudioPath,
    outputDir: ttsDir,
  });

  let originalAudioWavPath: string | undefined;
  if (cp.probe.hasAudio && origFilterSpec.enabled) {
    const extractedAudio = await extractAndProbeMedia({
      inputPath: inputVideoPath,
      outputPath: path.join(workDir, 'original_48k.wav'),
      toWav48k: true,
      ffmpegBin,
      ffprobeBin,
    });
    originalAudioWavPath = extractedAudio.extractedPath;
  }

  await mixMasterAudio({
    voiceSegments: ttsResult.audioSegments,
    originalAudioPath: originalAudioWavPath,
    originalAudioVolumePct,
    outputPath: masterAudioPath,
    fps,
    ffmpegBin,
  });
  cp.masterAudioPath = masterAudioPath;
  markStep(cp, 'DUB_AND_MASTER');
  await saveCheckpoint(checkpointPath, cp);

  // STEP 6: RENDER_EXPORT (delogo, subcover, burn subtitle with data/fonts/, probe_nvenc -> libx264)
  notify('RENDER_EXPORT', 90, 'Đang xuất video hoàn chỉnh...');
  const burnSub = options.burnSub !== false;
  let subtitlePath: string | undefined;
  if (burnSub && cp.adaptedSegments.length > 0) {
    subtitlePath = path.join(workDir, `${jobId}.srt`);
    await writeFile(subtitlePath, buildSrtContent(cp.adaptedSegments), 'utf8');
    cp.subtitlePath = subtitlePath;
  }

  const vfFilters: string[] = [];
  if (delogoBox) {
    vfFilters.push(`delogo=x=${delogoBox.x}:y=${delogoBox.y}:w=${delogoBox.w}:h=${delogoBox.h}`);
  }
  if (subcoverBox) {
    vfFilters.push(
      `drawbox=x=${subcoverBox.x}:y=${subcoverBox.y}:w=${subcoverBox.w}:h=${subcoverBox.h}:color=black@0.85:t=fill`,
    );
  }
  if (subtitlePath) {
    const fontsDir = options.fontsDir ?? resolveOpenReupFontsDir();
    const styleParts = ['FontSize=18', 'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H00000000', 'Outline=2'];
    if (safeFontName) styleParts.unshift(`FontName=${safeFontName}`);
    const subFilter = existsSync(fontsDir)
      ? `subtitles='${escapeFfmpegPath(subtitlePath)}':fontsdir='${escapeFfmpegPath(fontsDir)}':force_style='${styleParts.join(',')}'`
      : `subtitles='${escapeFfmpegPath(subtitlePath)}':force_style='${styleParts.join(',')}'`;
    vfFilters.push(subFilter);
  }

  const requestedEncoder = options.encoder ?? 'auto';
  let encoderUsed: 'h264_nvenc' | 'libx264' = 'libx264';
  if (requestedEncoder === 'nvenc') {
    encoderUsed = 'h264_nvenc';
  } else if (requestedEncoder === 'auto') {
    const probeRes = await probeNvenc({ ffmpegBin });
    encoderUsed = probeRes.encoder;
  }

  const buildRenderArgs = (enc: 'h264_nvenc' | 'libx264'): string[] => {
    const args: string[] = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputVideoPath,
      '-i',
      masterAudioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
    ];
    if (vfFilters.length > 0) {
      args.push('-vf', vfFilters.join(','));
    }
    if (enc === 'h264_nvenc') {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', outputVideoPath);
    return args;
  };

  try {
    await execFileAsync(ffmpegBin, buildRenderArgs(encoderUsed), { timeout: 300_000 });
  } catch (err) {
    if (encoderUsed === 'h264_nvenc' && requestedEncoder === 'auto') {
      encoderUsed = 'libx264';
      await execFileAsync(ffmpegBin, buildRenderArgs('libx264'), { timeout: 300_000 });
    } else {
      throw new ReupError(
        'ERR_REUP_RENDER_FAILED',
        `FFmpeg render failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  cp.outputVideoPath = outputVideoPath;
  markStep(cp, 'RENDER_EXPORT');
  await saveCheckpoint(checkpointPath, cp);
  notify('RENDER_EXPORT', 100, 'Hoàn tất xuất video ReupThreads');

  return {
    jobId,
    stepsCompleted: [...cp.completedSteps],
    inputVideoPath,
    masterAudioPath,
    subtitlePath,
    outputVideoPath,
    durationSec: cp.probe.durationSec,
    encoderUsed,
    originalAudioVolumePct,
    limiterApplied: origFilterSpec.limiterApplied,
    loudnessTargetLufs: -14,
    segmentCount: cp.adaptedSegments.length,
    checkpointPath,
    elapsedMs: Date.now() - startedAt,
  };
}
