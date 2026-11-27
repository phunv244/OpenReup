import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeMedia } from '../audio/ffmpeg-mastering.js';
import { resolveThreadsDownloadsDir } from '../paths.js';
import { ScraperError, isScraperError } from '../scraper/errors.js';
import { assertSafeMediaCdnUrl, validateThreadsUrl } from '../scraper/ssrf-guard.js';
import { Tier1SsrScraper } from '../scraper/tier1-ssr.js';
import { Tier2PlaywrightScraper } from '../scraper/tier2-playwright.js';
import type {
  FetchLike,
  RawMetaPostNode,
  RawMetaVideoVersion,
  RawScrapePayload,
} from '../scraper/types.js';
import { ReupError } from './errors.js';
import {
  DEFAULT_MAX_REUP_DURATION_SEC,
  DEFAULT_MAX_VIDEO_DOWNLOAD_BYTES,
  type ExtractThreadsVideoOptions,
  type ExtractThreadsVideoResult,
} from './types.js';

function pickBestVideoVersion(versions?: RawMetaVideoVersion[] | null): RawMetaVideoVersion | null {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const valid = versions.filter((v) => typeof v?.url === 'string' && v.url.startsWith('https://'));
  if (valid.length === 0) return null;
  valid.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  return valid[0] ?? null;
}

export function extractVideoUrlFromRawPost(rootPost: RawMetaPostNode): string | null {
  const direct = pickBestVideoVersion(rootPost.video_versions);
  if (direct?.url) return direct.url;

  if (Array.isArray(rootPost.carousel_media)) {
    for (const item of rootPost.carousel_media) {
      const candidate = pickBestVideoVersion(item.video_versions);
      if (candidate?.url) return candidate.url;
    }
  }
  return null;
}

export async function extractThreadsVideo(
  options: ExtractThreadsVideoOptions,
): Promise<ExtractThreadsVideoResult> {
  const parsedUrl = validateThreadsUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_MAX_REUP_DURATION_SEC;
  const warnings: string[] = [];

  const tier1 = new Tier1SsrScraper({
    timeoutMs,
    minRepliesForTier1: 0,
    fetchFn: options.fetchFn ?? options.serviceConfig?.fetchFn,
  });
  const tier2 = new Tier2PlaywrightScraper({
    timeoutMs,
    executablePath: options.serviceConfig?.chromiumExecutablePath,
  });

  let rawPayload: RawScrapePayload | null = null;
  let source: 'tier1_ssr' | 'tier2_playwright' = 'tier1_ssr';

  try {
    const tier1Outcome = await tier1.scrape(parsedUrl.canonicalUrl, parsedUrl.shortcode);
    rawPayload = tier1Outcome.payload;

    if ((!rawPayload || !extractVideoUrlFromRawPost(rawPayload.rootPost)) && (options.enableTier2Fallback ?? true)) {
      if (tier1Outcome.fallbackReason) warnings.push(tier1Outcome.fallbackReason);
      try {
        rawPayload = await tier2.scrape(parsedUrl.canonicalUrl, parsedUrl.shortcode);
        source = 'tier2_playwright';
      } catch (error) {
        if (!rawPayload) {
          if (isScraperError(error)) throw error;
          throw new ReupError(
            'ERR_REUP_INGEST_FAILED',
            `Failed to scrape Threads video post: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        warnings.push(
          `Tier 2 fallback skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await tier2.close();
  }

  if (!rawPayload) {
    throw new ScraperError('ERR_POST_NOT_FOUND', {
      details: { canonicalUrl: parsedUrl.canonicalUrl },
    });
  }

  const videoUrl = extractVideoUrlFromRawPost(rawPayload.rootPost);
  if (!videoUrl) {
    throw new ReupError(
      'ERR_NO_VIDEO_IN_POST',
      'Bài viết Threads không chứa video. Hãy dùng chế độ Chữ/Ảnh (VideoThreads).',
      { details: { canonicalUrl: parsedUrl.canonicalUrl, shortcode: parsedUrl.shortcode } },
    );
  }

  // SSRF defense: validate video CDN URL (whitelist + private IP + DNS) before fetching
  try {
    await assertSafeMediaCdnUrl(videoUrl, {
      verifyDns: options.serviceConfig?.verifyDns,
      dnsLookupFn: options.serviceConfig?.dnsLookupFn,
      allowLocalTestHosts: options.serviceConfig?.allowLocalTestHosts,
    });
  } catch (error) {
    throw new ReupError(
      'ERR_VALIDATION_FAILED',
      error instanceof Error ? error.message : `SSRF_BLOCKED: ${String(error)}`,
      { cause: error, details: { videoUrl } },
    );
  }

  const outDir = options.outputDir ?? resolveThreadsDownloadsDir();
  await mkdir(outDir, { recursive: true });
  const localVideoPath = path.join(outDir, `threads_src_${parsedUrl.shortcode}.mp4`);
  const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_VIDEO_DOWNLOAD_BYTES;

  const fetchFn: FetchLike = options.fetchFn ?? options.serviceConfig?.fetchFn ?? ((i, init) => fetch(i, init));
  const resp = await fetchFn(videoUrl, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(timeoutMs, 30_000)),
  });

  if (resp.status >= 300 && resp.status < 400) {
    throw new ReupError(
      'ERR_REUP_INGEST_FAILED',
      `SSRF_BLOCKED: Redirect (${resp.status}) is not permitted while downloading Threads video`,
      { details: { status: resp.status, location: resp.headers.get('location') ?? '', videoUrl } },
    );
  }

  if (!resp.ok) {
    throw new ReupError(
      'ERR_REUP_INGEST_FAILED',
      `Failed to download Threads video (${resp.status}) from ${videoUrl}`,
      { details: { status: resp.status, videoUrl } },
    );
  }

  const contentLengthRaw = resp.headers.get('content-length');
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
      throw new ReupError(
        'ERR_REUP_INGEST_FAILED',
        `Threads video exceeds maximum allowed size (${contentLength} > ${maxDownloadBytes} bytes)`,
        { details: { contentLength, maxDownloadBytes, videoUrl } },
      );
    }
  }

  let buffer: Buffer;
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxDownloadBytes) {
            await reader.cancel();
            throw new ReupError(
              'ERR_REUP_INGEST_FAILED',
              `Threads video stream exceeded maximum allowed size (${maxDownloadBytes} bytes)`,
              { details: { totalBytes, maxDownloadBytes, videoUrl } },
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    buffer = Buffer.concat(chunks);
  } else {
    const rawBuf = Buffer.from(await resp.arrayBuffer());
    if (rawBuf.byteLength > maxDownloadBytes) {
      throw new ReupError(
        'ERR_REUP_INGEST_FAILED',
        `Threads video exceeds maximum allowed size (${rawBuf.byteLength} > ${maxDownloadBytes} bytes)`,
        { details: { size: rawBuf.byteLength, maxDownloadBytes, videoUrl } },
      );
    }
    buffer = rawBuf;
  }

  if (buffer.byteLength === 0) {
    throw new ReupError('ERR_REUP_INGEST_FAILED', 'Downloaded Threads video is empty', {
      details: { videoUrl },
    });
  }
  await writeFile(localVideoPath, buffer);

  const probe = await probeMedia(localVideoPath, { ffprobeBin: options.ffprobeBin });
  if (maxDurationSec > 0 && probe.durationSec > maxDurationSec) {
    throw new ReupError(
      'ERR_VIDEO_TOO_LONG',
      `Video dài ${probe.durationSec.toFixed(1)}s vượt giới hạn mặc định ${maxDurationSec}s.`,
      { details: { durationSec: probe.durationSec, maxDurationSec } },
    );
  }

  return {
    shortcode: parsedUrl.shortcode,
    canonicalUrl: parsedUrl.canonicalUrl,
    authorHandle: rawPayload.rootPost.user?.username ?? parsedUrl.authorHandle ?? 'threads_user',
    caption: rawPayload.rootPost.caption?.text?.trim() ?? '',
    videoUrl,
    localVideoPath,
    durationSec: probe.durationSec,
    width: probe.videoStream?.width ?? 1080,
    height: probe.videoStream?.height ?? 1920,
    fps: probe.videoStream?.fps ?? 30,
    hasAudio: Boolean(probe.audioStream),
    source,
    warnings,
  };
}
