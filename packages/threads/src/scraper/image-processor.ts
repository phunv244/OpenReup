import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { assertSafeMediaCdnUrl } from './ssrf-guard.js';
import type { FetchLike, ImageProcessorConfig } from './types.js';

// Bound libvips memory cache on 14GB host per ARCHITECTURE.md 7.1
sharp.cache({ memory: 50, files: 0 });

export const DEFAULT_MAX_IMAGE_WIDTH = 1080;
export const DEFAULT_WEBP_QUALITY = 85;
export const DEFAULT_IMAGE_MAX_RETRIES = 2;
export const DEFAULT_IMAGE_TIMEOUT_MS = 5_000;
export const DEFAULT_IMAGE_MAX_BYTES = 15 * 1024 * 1024; // 15 MiB
export const SHARED_IMAGE_CACHE_SUBDIR = path.join('images', 'shared');

export interface ProcessedImageSuccess {
  ok: true;
  localPath: string;
  originalUrl: string;
  width: number;
  height: number;
  aspectRatio: number;
  bytes: number;
  fromCache: boolean;
}

export interface ProcessedImageFailure {
  ok: false;
  imageFailed: true;
  originalUrl: string;
  reason: string;
  ssrfBlocked: boolean;
}

export type ProcessedImageResult = ProcessedImageSuccess | ProcessedImageFailure;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hashCacheKey(url: string, maxWidth: number, quality: number): string {
  return createHash('sha256')
    .update(`${url}|w=${maxWidth}|q=${quality}`)
    .digest('hex')
    .slice(0, 32);
}

async function readResponseWithSizeLimit(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error(`IMAGE_TOO_LARGE: Content-Length ${parsedLength} exceeds limit ${maxBytes}`);
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(
      `IMAGE_TOO_LARGE: Downloaded ${arrayBuffer.byteLength} bytes exceeds limit ${maxBytes}`,
    );
  }
  return Buffer.from(arrayBuffer);
}

export class ImageProcessor {
  private readonly cacheDir: string;
  private readonly maxWidth: number;
  private readonly webpQuality: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchFn: FetchLike;
  private readonly verifyDns: boolean;
  private readonly dnsLookupFn: ImageProcessorConfig['dnsLookupFn'];
  private readonly allowLocalTestHosts: boolean;

  constructor(config: ImageProcessorConfig) {
    this.cacheDir = config.cacheDir;
    this.maxWidth = config.maxWidth ?? DEFAULT_MAX_IMAGE_WIDTH;
    this.webpQuality = config.webpQuality ?? DEFAULT_WEBP_QUALITY;
    this.maxRetries = config.maxRetries ?? DEFAULT_IMAGE_MAX_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
    this.maxBytes = config.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
    this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
    this.verifyDns = config.verifyDns ?? true;
    this.dnsLookupFn = config.dnsLookupFn;
    this.allowLocalTestHosts = config.allowLocalTestHosts ?? false;
  }

  async processImage(
    rawUrl: string,
    options?: { subDir?: string; maxWidth?: number },
  ): Promise<ProcessedImageResult> {
    const targetMaxWidth = options?.maxWidth ?? this.maxWidth;

    // 1. SSRF Whitelist & Private IP / DNS Rebinding Guard
    let safeUrl: URL;
    try {
      safeUrl = await assertSafeMediaCdnUrl(rawUrl, {
        verifyDns: this.verifyDns,
        dnsLookupFn: this.dnsLookupFn,
        allowLocalTestHosts: this.allowLocalTestHosts,
      });
    } catch (error) {
      return {
        ok: false,
        imageFailed: true,
        originalUrl: rawUrl,
        reason: error instanceof Error ? error.message : 'SSRF_BLOCKED',
        ssrfBlocked: true,
      };
    }

    const targetDir = path.join(this.cacheDir, options?.subDir ?? SHARED_IMAGE_CACHE_SUBDIR);
    const cacheKey = hashCacheKey(safeUrl.toString(), targetMaxWidth, this.webpQuality);
    const outputPath = path.join(targetDir, `${cacheKey}.webp`);

    // 2. NVMe Local Cache Hit check
    if (await fileExists(outputPath)) {
      try {
        const cachedBuffer = await readFile(outputPath);
        const meta = await sharp(cachedBuffer).metadata();
        if (meta.width && meta.height) {
          return {
            ok: true,
            localPath: outputPath,
            originalUrl: rawUrl,
            width: meta.width,
            height: meta.height,
            aspectRatio: Number((meta.width / meta.height).toFixed(4)),
            bytes: cachedBuffer.byteLength,
            fromCache: true,
          };
        }
      } catch {
        // Corrupt cache file; fall through to re-download
      }
    }

    // 3. Download with retry (maxRetries = 2 per ST-MED-06) + Sharp WebP 85% transform
    let lastReason = 'Unknown image download error';
    const totalAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchFn(safeUrl.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
        });

        // Reject redirects to prevent open-redirect SSRF bypass
        if (response.status >= 300 && response.status < 400) {
          return {
            ok: false,
            imageFailed: true,
            originalUrl: rawUrl,
            reason: `SSRF_BLOCKED: Unexpected redirect (${response.status}) while fetching media`,
            ssrfBlocked: true,
          };
        }

        if (!response.ok) {
          lastReason = `HTTP ${response.status} while downloading image`;
          // 404 / 403 / 410 won't recover on retry
          if (response.status === 404 || response.status === 403 || response.status === 410) {
            break;
          }
          continue;
        }

        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (contentType.startsWith('video/') || contentType.includes('mpegurl')) {
          return {
            ok: false,
            imageFailed: true,
            originalUrl: rawUrl,
            reason: `NO_VIDEO_POLICY: Refused video content-type "${contentType}"`,
            ssrfBlocked: false,
          };
        }

        const rawBuffer = await readResponseWithSizeLimit(response, this.maxBytes);
        const { data: webpBuffer, info } = await sharp(rawBuffer, { failOn: 'error' })
          .rotate()
          .resize({
            width: targetMaxWidth,
            withoutEnlargement: true,
            fit: 'inside',
          })
          .webp({ quality: this.webpQuality })
          .toBuffer({ resolveWithObject: true });

        if (!info.width || !info.height) {
          throw new Error('CORRUPT_IMAGE: Sharp produced invalid dimensions');
        }

        await mkdir(targetDir, { recursive: true });
        const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmpPath, webpBuffer);
        await rename(tmpPath, outputPath);

        return {
          ok: true,
          localPath: outputPath,
          originalUrl: rawUrl,
          width: info.width,
          height: info.height,
          aspectRatio: Number((info.width / info.height).toFixed(4)),
          bytes: webpBuffer.byteLength,
          fromCache: false,
        };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      ok: false,
      imageFailed: true,
      originalUrl: rawUrl,
      reason: lastReason,
      ssrfBlocked: false,
    };
  }
}
