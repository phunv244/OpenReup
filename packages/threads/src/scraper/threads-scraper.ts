import type { PostRepository } from '../db/index.js';
import { resolveThreadsCacheDir } from '../paths.js';
import { ScraperError, isScraperError } from './errors.js';
import { ImageProcessor } from './image-processor.js';
import {
  DEFAULT_AVATAR_PLACEHOLDER,
  DEFAULT_POST_CACHE_TTL_SECONDS,
  mapRawThreadToNormalizedPost,
} from './post-mapper.js';
import { validateThreadsUrl } from './ssrf-guard.js';
import {
  DEFAULT_MIN_REPLIES_FOR_TIER1,
  DEFAULT_TIER1_TIMEOUT_MS,
  Tier1SsrScraper,
} from './tier1-ssr.js';
import {
  Tier2PlaywrightScraper,
  type BrowserPoolLike,
} from './tier2-playwright.js';
import type {
  RawScrapePayload,
  ScrapeOptions,
  ScrapeResult,
  ScrapeTierSource,
  ScraperServiceConfig,
} from './types.js';

export interface ThreadsScraperDependencies {
  tier1Scraper?: Tier1SsrScraper;
  tier2Scraper?: Tier2PlaywrightScraper;
  imageProcessor?: ImageProcessor;
  browserPool?: BrowserPoolLike;
}

export class ThreadsScraperService {
  private readonly postRepository?: PostRepository;
  private readonly cacheTtlSeconds: number;
  private readonly enableTier2Fallback: boolean;
  private readonly defaultAvatarPath: string;
  private readonly tier1: Tier1SsrScraper;
  private readonly tier2: Tier2PlaywrightScraper;
  private readonly imageProcessor: ImageProcessor;

  constructor(
    config?: ScraperServiceConfig,
    deps?: ThreadsScraperDependencies,
  ) {
    this.postRepository = config?.postRepository;
    this.cacheTtlSeconds =
      config?.cacheTtlSeconds ?? DEFAULT_POST_CACHE_TTL_SECONDS;
    this.enableTier2Fallback = config?.enableTier2Fallback ?? true;
    this.defaultAvatarPath =
      config?.defaultAvatarPath ?? DEFAULT_AVATAR_PLACEHOLDER;

    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIER1_TIMEOUT_MS;
    const cacheDir = config?.cacheDir ?? resolveThreadsCacheDir();

    this.tier1 =
      deps?.tier1Scraper ??
      new Tier1SsrScraper({
        timeoutMs,
        minRepliesForTier1:
          config?.minRepliesForTier1 ?? DEFAULT_MIN_REPLIES_FOR_TIER1,
        fetchFn: config?.fetchFn,
      });

    this.tier2 =
      deps?.tier2Scraper ??
      new Tier2PlaywrightScraper({
        timeoutMs,
        browserPool: deps?.browserPool,
        executablePath: config?.chromiumExecutablePath,
      });

    this.imageProcessor =
      deps?.imageProcessor ??
      new ImageProcessor({
        cacheDir,
        fetchFn: config?.fetchFn,
        verifyDns: config?.verifyDns,
        dnsLookupFn: config?.dnsLookupFn,
        allowLocalTestHosts: config?.allowLocalTestHosts,
      });
  }

  async scrapePost(rawUrl: string, options?: ScrapeOptions): Promise<ScrapeResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];

    // 1. Strict URL & SSRF validation (< 10ms, ST-ERR-01)
    const parsedUrl = validateThreadsUrl(rawUrl);
    const nowEpochSec = options?.nowEpochSec ?? Math.floor(Date.now() / 1000);

    // 2. Post Cache lookup (TTL 6h)
    if (this.postRepository && !options?.bypassCache) {
      const cached = this.postRepository.findValidCacheByShortcode(
        parsedUrl.shortcode,
        nowEpochSec,
      );
      if (cached) {
        return {
          post: cached,
          source: 'cache',
          durationMs: Date.now() - startedAt,
          warnings,
        };
      }
    }

    // 3. Tier 1: Fast HTTP/2 SSR Relay JSON Parser
    const tier1Outcome = await this.tier1.scrape(
      parsedUrl.canonicalUrl,
      parsedUrl.shortcode,
    );

    let rawPayload: RawScrapePayload | null = tier1Outcome.payload;
    let source: ScrapeTierSource = 'tier1_ssr';

    // 4. Tier 2: Warm Playwright + GraphQL Interceptor Fallback
    if (tier1Outcome.needsTier2Fallback) {
      if (tier1Outcome.fallbackReason) {
        warnings.push(tier1Outcome.fallbackReason);
      }

      if (this.enableTier2Fallback) {
        try {
          rawPayload = await this.tier2.scrape(
            parsedUrl.canonicalUrl,
            parsedUrl.shortcode,
          );
          source = 'tier2_playwright';
        } catch (error) {
          // Propagate hard domain/security/timeout errors immediately
          if (
            isScraperError(error) &&
            (error.code === 'ERR_PRIVATE_ACCOUNT' ||
              error.code === 'ERR_RATE_LIMITED' ||
              error.code === 'ERR_SCRAPER_TIMEOUT' ||
              error.code === 'ERR_POST_NOT_FOUND')
          ) {
            // If Tier 1 already extracted a valid root post (only missing replies), degrade gracefully
            if (!rawPayload) {
              throw error;
            }
            warnings.push(`Tier 2 fallback failed (${error.code}); using Tier 1 SSR payload`);
          } else if (!rawPayload) {
            throw error;
          }
        }
      }
    }

    if (!rawPayload) {
      throw new ScraperError('ERR_POST_NOT_FOUND', {
        details: { canonicalUrl: parsedUrl.canonicalUrl },
      });
    }

    // 5. Strict No-Video Policy + Sharp WebP Pre-fetch + Zod NormalizedThreadsPost Mapping
    const mapped = await mapRawThreadToNormalizedPost(rawPayload, {
      canonicalUrl: parsedUrl.canonicalUrl,
      shortcode: parsedUrl.shortcode,
      imageProcessor: this.imageProcessor,
      jobId: options?.jobId,
      cacheTtlSeconds: this.cacheTtlSeconds,
      nowEpochSec,
      defaultAvatarPath: this.defaultAvatarPath,
    });

    warnings.push(...mapped.warnings);

    // 6. Persist into SQLite cache if repository provided
    const persistedPost = this.postRepository
      ? this.postRepository.upsert(mapped.post)
      : mapped.post;

    return {
      post: persistedPost,
      source,
      durationMs: Date.now() - startedAt,
      warnings,
    };
  }

  async close(): Promise<void> {
    await this.tier2.close();
  }
}
