import { z } from 'zod';
import type { NormalizedThreadsPost, ParsedThreadsUrl } from '../contracts/index.js';
import { resolveThreadsCacheDir } from '../paths.js';
import {
  ImageProcessor,
  MAX_IMAGE_DOWNLOAD_CONCURRENCY,
  ThreadsScraperService,
  runWithConcurrency,
  validateThreadsUrl,
  type FetchLike,
  type ProcessedImageResult,
  type ScrapeTierSource,
  type ScraperServiceConfig,
} from '../scraper/index.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export const ParseThreadsUrlInputSchema = z.object({
  url: z.string().min(1),
});
export type ParseThreadsUrlInput = z.infer<typeof ParseThreadsUrlInputSchema>;

export function parseAndValidateThreadsUrl(
  input: ParseThreadsUrlInput,
): Promise<CodeModeResult<ParsedThreadsUrl>> {
  return runCodeMode(() => {
    const parsed = ParseThreadsUrlInputSchema.parse(input);
    return validateThreadsUrl(parsed.url);
  });
}

export const ScrapeThreadsPostInputSchema = z.object({
  url: z.string().min(1),
  bypassCache: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
  cacheDir: z.string().min(1).optional(),
  enableTier2Fallback: z.boolean().optional(),
  jobId: z.string().min(1).optional(),
});
export type ScrapeThreadsPostInput = z.infer<typeof ScrapeThreadsPostInputSchema>;

export interface ScrapeThreadsPostData {
  post: NormalizedThreadsPost;
  source: ScrapeTierSource;
}

export function scrapeThreadsPost(
  input: ScrapeThreadsPostInput & {
    serviceConfig?: Partial<ScraperServiceConfig>;
  },
): Promise<CodeModeResult<ScrapeThreadsPostData>> {
  return runCodeMode(async (warnings) => {
    const parsed = ScrapeThreadsPostInputSchema.parse(input);
    const service = new ThreadsScraperService({
      ...input.serviceConfig,
      timeoutMs: parsed.timeoutMs ?? input.serviceConfig?.timeoutMs,
      cacheDir: parsed.cacheDir ?? input.serviceConfig?.cacheDir,
      enableTier2Fallback:
        parsed.enableTier2Fallback ?? input.serviceConfig?.enableTier2Fallback,
    });

    try {
      const result = await service.scrapePost(parsed.url, {
        bypassCache: parsed.bypassCache,
        jobId: parsed.jobId,
      });
      warnings.push(...result.warnings);
      return {
        post: result.post,
        source: result.source,
      };
    } finally {
      await service.close();
    }
  });
}

export const PrefetchImagesInputSchema = z.object({
  items: z
    .array(
      z.object({
        url: z.string().min(1),
        maxWidth: z.number().int().positive().max(2160).optional(),
      }),
    )
    .min(1),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_IMAGE_DOWNLOAD_CONCURRENCY)
    .default(MAX_IMAGE_DOWNLOAD_CONCURRENCY),
  cacheDir: z.string().min(1).optional(),
});
export type PrefetchImagesInput = z.input<typeof PrefetchImagesInputSchema>;

export interface PrefetchImagesData {
  results: ProcessedImageResult[];
  succeededCount: number;
  failedCount: number;
}

export function prefetchAndOptimizeImages(
  input: PrefetchImagesInput & {
    fetchFn?: FetchLike;
    verifyDns?: boolean;
    allowLocalTestHosts?: boolean;
  },
): Promise<CodeModeResult<PrefetchImagesData>> {
  return runCodeMode(async () => {
    const parsed = PrefetchImagesInputSchema.parse(input);
    const cacheDir = parsed.cacheDir ?? resolveThreadsCacheDir();

    const processor = new ImageProcessor({
      cacheDir,
      fetchFn: input.fetchFn,
      verifyDns: input.verifyDns,
      allowLocalTestHosts: input.allowLocalTestHosts,
    });

    const results = await runWithConcurrency(
      parsed.items,
      parsed.concurrency,
      (item) => processor.processImage(item.url, { maxWidth: item.maxWidth }),
    );

    const succeededCount = results.filter((r) => r.ok).length;
    return {
      results,
      succeededCount,
      failedCount: results.length - succeededCount,
    };
  });
}
