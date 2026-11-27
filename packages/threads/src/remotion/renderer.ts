import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { AsyncSemaphore } from '../audio/tts-engine.js';
import type { VideoCompositionProps } from '../contracts/video-composition.js';
import {
  resolveRemotionEntryPoint,
  resolveRemotionPublicDir,
  resolveThreadsDownloadsDir,
} from '../paths.js';

export const RENDER_JOB_CONCURRENCY = 1;
const renderSemaphore = new AsyncSemaphore(RENDER_JOB_CONCURRENCY);

let cachedBundleLocation: string | null = null;
let bundlingPromise: Promise<string> | null = null;

export function toPublicRelativePath(
  rawPath: string,
  rootDir: string = resolveRemotionPublicDir(),
): string {
  if (!rawPath) return '';
  if (
    rawPath.startsWith('http://') ||
    rawPath.startsWith('https://') ||
    rawPath.startsWith('data:')
  ) {
    return rawPath;
  }
  if (path.isAbsolute(rawPath)) {
    const rel = path.relative(rootDir, rawPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  return rawPath.replace(/^\/+/, '').split(path.sep).join('/');
}

function normalizePropsMediaPaths(props: VideoCompositionProps): VideoCompositionProps {
  const publicDir = resolveRemotionPublicDir();
  return {
    ...props,
    background: {
      ...props.background,
      videoSrc: toPublicRelativePath(props.background.videoSrc, publicDir),
    },
    audio: {
      ...props.audio,
      masterAudioSrc: toPublicRelativePath(props.audio.masterAudioSrc, publicDir),
    },
    segments: props.segments.map((seg) => ({
      ...seg,
      card: {
        ...seg.card,
        authorAvatarSrc: toPublicRelativePath(seg.card.authorAvatarSrc, publicDir),
        images: seg.card.images.map((img) => ({
          ...img,
          src: toPublicRelativePath(img.src, publicDir),
        })),
      },
    })),
  };
}

export async function getOrBuildRemotionBundle(): Promise<string> {
  if (cachedBundleLocation && existsSync(cachedBundleLocation)) {
    return cachedBundleLocation;
  }
  if (bundlingPromise) {
    return bundlingPromise;
  }

  const entryPoint = resolveRemotionEntryPoint();
  const publicDir = resolveRemotionPublicDir();

  bundlingPromise = bundle({
    entryPoint,
    publicDir,
    symlinkPublicDir: true,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: {
          '.js': ['.ts', '.tsx', '.js'],
        },
      },
    }),
  })
    .then((bundleLoc) => {
      cachedBundleLocation = bundleLoc;
      bundlingPromise = null;
      return bundleLoc;
    })
    .catch((err) => {
      bundlingPromise = null;
      throw err;
    });

  return bundlingPromise;
}

export interface RenderStillOptions {
  frame?: number;
  outputPath?: string;
  theme?: 'dark' | 'light';
}

export interface RenderStillResult {
  outputPath: string;
  frame: number;
  width: number;
  height: number;
  fileSizeBytes: number;
  elapsedMs: number;
}

export async function renderPreviewStill(
  props: VideoCompositionProps,
  options?: RenderStillOptions,
): Promise<RenderStillResult> {
  return renderSemaphore.run(async () => {
    const started = Date.now();
    const normalizedProps = normalizePropsMediaPaths(props);
    const bundleLocation = await getOrBuildRemotionBundle();

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'ThreadsVideo',
      inputProps: normalizedProps,
    });

    if (composition.durationInFrames !== normalizedProps.meta.totalFrames) {
      throw new Error(
        `Composition duration mismatch in renderPreviewStill: Remotion selected ${composition.durationInFrames} frames, expected ${normalizedProps.meta.totalFrames} frames.`,
      );
    }

    const frame = options?.frame ?? Math.min(60, Math.floor(composition.durationInFrames / 2));
    const outputDir = options?.outputPath
      ? path.dirname(path.resolve(options.outputPath))
      : resolveThreadsDownloadsDir();
    await mkdir(outputDir, { recursive: true });

    const outputPath =
      options?.outputPath ??
      path.resolve(outputDir, `preview_${normalizedProps.meta.jobId}_frame${frame}.png`);

    await renderStill({
      composition,
      serveUrl: bundleLocation,
      output: outputPath,
      frame,
      inputProps: normalizedProps,
      imageFormat: 'png',
      browserExecutable: undefined,
      chromiumOptions: {
        gl: 'angle',
      },
    });

    const stats = statSync(outputPath);

    return {
      outputPath,
      frame,
      width: composition.width,
      height: composition.height,
      fileSizeBytes: stats.size,
      elapsedMs: Date.now() - started,
    };
  });
}

export interface RenderVideoOptions {
  outputPath?: string;
  codec?: 'h264' | 'h265' | 'vp8' | 'vp9';
  crf?: number;
  onProgress?: (progress: number) => void;
  concurrency?: number;
}

export interface RenderVideoResult {
  outputPath: string;
  durationInFrames: number;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
  durationSec: number;
  fileSizeBytes: number;
  renderElapsedMs: number;
  realtimeMultiplier: number;
}

export async function renderThreadsVideo(
  props: VideoCompositionProps,
  options?: RenderVideoOptions,
): Promise<RenderVideoResult> {
  return renderSemaphore.run(async () => {
    const started = Date.now();
    const normalizedProps = normalizePropsMediaPaths(props);
    const bundleLocation = await getOrBuildRemotionBundle();

    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'ThreadsVideo',
      inputProps: normalizedProps,
    });

    if (composition.durationInFrames !== normalizedProps.meta.totalFrames) {
      throw new Error(
        `Composition duration mismatch in renderThreadsVideo: Remotion selected ${composition.durationInFrames} frames, expected ${normalizedProps.meta.totalFrames} frames. Verify calculateMetadata in src/remotion/Root.tsx.`,
      );
    }

    const outputDir = options?.outputPath
      ? path.dirname(path.resolve(options.outputPath))
      : resolveThreadsDownloadsDir();
    await mkdir(outputDir, { recursive: true });

    const outputPath =
      options?.outputPath ??
      path.resolve(outputDir, `video_${normalizedProps.meta.jobId}.mp4`);

    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      outputLocation: outputPath,
      inputProps: normalizedProps,
      codec: options?.codec ?? 'h264',
      crf: options?.crf,
      hardwareAcceleration: 'if-possible',
      chromiumOptions: {
        gl: 'angle',
      },
      concurrency: options?.concurrency ?? 6,
      onProgress: (p) => {
        if (options?.onProgress) {
          options.onProgress(p.progress);
        }
      },
    });

    const elapsedMs = Date.now() - started;
    const stats = statSync(outputPath);
    const durationSec = Number((composition.durationInFrames / composition.fps).toFixed(4));
    const realtimeMultiplier = Number((durationSec / Math.max(0.001, elapsedMs / 1000)).toFixed(2));

    return {
      outputPath,
      durationInFrames: composition.durationInFrames,
      totalFrames: composition.durationInFrames,
      fps: composition.fps,
      width: composition.width,
      height: composition.height,
      durationSec,
      fileSizeBytes: stats.size,
      renderElapsedMs: elapsedMs,
      realtimeMultiplier,
    };
  });
}

export interface OpenVideoPreviewResult {
  command: string;
  studioUrl: string;
  port: number;
  description: string;
}

export function openVideoPreview(options?: { port?: number }): OpenVideoPreviewResult {
  const port = options?.port ?? 3001;
  return {
    command: `npm run preview -- --port=${port}`,
    studioUrl: `http://localhost:${port}`,
    port,
    description: `Remotion Studio Live Preview is available on port ${port}. Run 'npm run preview' to interactively inspect timeline, visual props, and audio sync.`,
  };
}
