#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runThreadsVideoPipeline } from './code-mode/pipeline.js';
import {
  extractThreadsVideo,
  probeReupNvenc,
  runReupThreadsPipeline,
} from './code-mode/reup.js';
import { scrapeThreadsPost } from './code-mode/scraper.js';
import type { Fps, Theme, VoiceId } from './contracts/common.js';
import { resolveOpenReupMediaRoot, resolveThreadsDownloadsDir } from './paths.js';

export function emitProgress(pct: number, label: string, stage = 0): void {
  const payload = {
    pct: Math.round(Math.min(100, Math.max(0, pct))),
    label,
    eta: null,
    stage,
  };
  process.stdout.write(`@@PROGRESS ${JSON.stringify(payload)}\n`);
}

export function emitSavedFile(absPath: string): void {
  const mediaRoot = resolveOpenReupMediaRoot();
  const rel = path.relative(mediaRoot, path.resolve(absPath)).split(path.sep).join('/');
  if (rel.startsWith('downloads/')) {
    process.stdout.write(`SAVED_FILE:::${rel}\n`);
  }
}

export function parseCliArgs(argv: readonly string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  let command = '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else if (!command) {
      command = token;
    }
  }
  if (!command && typeof flags['mode'] === 'string') {
    command = flags['mode'];
  }
  return { command, flags };
}

function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function numFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const s = strFlag(flags, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

function boolFlag(flags: Record<string, string | boolean>, key: string, defaultVal: boolean): boolean {
  const v = flags[key];
  if (v === undefined) return defaultVal;
  if (typeof v === 'boolean') return v;
  return v !== 'false' && v !== '0';
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseCliArgs(argv);

  if (!command || command === 'help' || flags['help']) {
    process.stdout.write(
      'Usage: node dist/cli.js <video-threads|reup-threads|scrape|extract-video|probe-nvenc> [--url ...]\n',
    );
    return 0;
  }

  if (command === 'probe-nvenc') {
    const res = await probeReupNvenc({ force: true });
    process.stdout.write(`@@RESULT ${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }

  if (command === 'scrape') {
    const url = strFlag(flags, 'url') ?? '';
    emitProgress(15, 'Đang cào bài viết Threads...', 1);
    const res = await scrapeThreadsPost({
      url,
      bypassCache: boolFlag(flags, 'bypass-cache', false),
      jobId: strFlag(flags, 'job-id'),
    });
    emitProgress(100, res.ok ? 'Hoàn tất cào bài viết Threads' : 'Lỗi cào bài viết Threads', 1);
    process.stdout.write(`@@RESULT ${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }

  if (command === 'extract-video') {
    const url = strFlag(flags, 'url') ?? '';
    emitProgress(15, 'Đang trích xuất video Threads...', 1);
    const res = await extractThreadsVideo({
      url,
      outputDir: strFlag(flags, 'output-dir') ?? resolveThreadsDownloadsDir(),
      maxDurationSec: numFlag(flags, 'max-duration-sec'),
    });
    if (res.ok) {
      emitSavedFile(res.data.localVideoPath);
    }
    emitProgress(100, res.ok ? 'Hoàn tất trích xuất video' : 'Lỗi trích xuất video', 1);
    process.stdout.write(`@@RESULT ${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }

  if (command === 'video-threads') {
    const jobId = strFlag(flags, 'job-id') ?? `vt_${Date.now()}`;
    const outputPath =
      strFlag(flags, 'output') ?? path.join(resolveThreadsDownloadsDir(), `${jobId}.mp4`);
    const previewStillPath =
      strFlag(flags, 'preview-still') ?? path.join(resolveThreadsDownloadsDir(), `${jobId}.png`);
    const fpsRaw = numFlag(flags, 'fps');
    const fps: Fps = fpsRaw === 30 ? 30 : 60;
    const theme: Theme = strFlag(flags, 'theme') === 'light' ? 'light' : 'dark';

    const stageMap: Record<string, number> = {
      SCRAPING: 1,
      DIRECTING: 2,
      TTS_SYNTHESIS: 3,
      AUDIO_MASTERING: 4,
      BUILD_PROPS: 5,
      RENDERING_PREVIEW: 5,
      RENDERING_VIDEO: 6,
      DONE: 6,
    };

    emitProgress(2, 'Khởi tạo VideoThreads pipeline...', 1);
    const res = await runThreadsVideoPipeline({
      url: strFlag(flags, 'url'),
      jobId,
      voiceId: strFlag(flags, 'voice') as VoiceId | undefined,
      refAudioPath: strFlag(flags, 'ref-audio'),
      theme,
      fps,
      dimOpacity: numFlag(flags, 'dim-opacity'),
      backgroundVideoPath: strFlag(flags, 'bg-video'),
      outputPath,
      previewStillPath,
      maxComments: numFlag(flags, 'max-comments'),
      onProgress: (stage, pct) => {
        emitProgress(pct, `VideoThreads · ${stage}`, stageMap[stage] ?? 0);
      },
    });
    if (res.ok) {
      emitSavedFile(res.data.videoPath);
    }
    process.stdout.write(`@@RESULT ${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }

  if (command === 'reup-threads') {
    const jobId = strFlag(flags, 'job-id') ?? `rt_${Date.now()}`;
    const outputPath =
      strFlag(flags, 'output') ?? path.join(resolveThreadsDownloadsDir(), `${jobId}.mp4`);
    const stepStage: Record<string, number> = {
      INGEST: 1,
      PROBE: 2,
      TRANSCRIBE: 3,
      ADAPT_SCRIPT: 4,
      DUB_AND_MASTER: 5,
      RENDER_EXPORT: 6,
    };
    const volPct = numFlag(flags, 'original-audio-volume-pct');

    emitProgress(2, 'Khởi tạo ReupThreads pipeline...', 1);
    const res = await runReupThreadsPipeline({
      url: strFlag(flags, 'url'),
      localVideoPath: strFlag(flags, 'local-video'),
      jobId,
      workDir: strFlag(flags, 'work-dir'),
      outputPath,
      voiceId: strFlag(flags, 'voice') as VoiceId | undefined,
      refAudioPath: strFlag(flags, 'ref-audio'),
      originalAudioVolumePct: volPct,
      maxDurationSec: numFlag(flags, 'max-duration-sec'),
      delogo: strFlag(flags, 'delogo'),
      subcover: strFlag(flags, 'subcover'),
      burnSub: boolFlag(flags, 'burn-sub', true),
      fontName: strFlag(flags, 'font-name'),
      agyModel: strFlag(flags, 'agy-model'),
      skipAgy: boolFlag(flags, 'skip-agy', false),
      encoder: (strFlag(flags, 'encoder') as 'auto' | 'nvenc' | 'cpu' | undefined) ?? 'auto',
      onProgress: (step, pct, label) => {
        emitProgress(pct, label, stepStage[step] ?? 0);
      },
    });
    if (res.ok) {
      emitSavedFile(res.data.outputVideoPath);
    }
    process.stdout.write(`@@RESULT ${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 1;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  return 2;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
