import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import {
  ScraperError,
  isScraperError,
  isTimeoutError,
  mapHttpStatusToScraperError,
} from './errors.js';
import {
  buildRawScrapePayload,
  detectBlockedUrlOrHtml,
  extractThreadFromGraphql,
  extractThreadFromHtml,
} from './relay-parser.js';
import type { RawMetaPostNode, RawScrapePayload } from './types.js';

export const DEFAULT_TIER2_TIMEOUT_MS = 10_000;

const BLOCKED_RESOURCE_TYPES = new Set(['media', 'font', 'stylesheet']);
const BLOCKED_URL_PATTERNS = [
  /\.mp4(\?|$)/i,
  /\.m3u8(\?|$)/i,
  /\.webm(\?|$)/i,
  /\.mov(\?|$)/i,
  /\/logging\//i,
  /\/ajax\/bz/i,
  /google-analytics\.com/i,
  /doubleclick\.net/i,
];

const GRAPHQL_ENDPOINT_PATTERNS = ['/api/graphql', '/graphql/query'];

const CHROMIUM_CANDIDATE_PATHS = [
  process.env['CHROMIUM_EXECUTABLE_PATH'],
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

export function shouldBlockPlaywrightRequest(
  resourceType: string,
  url: string,
): boolean {
  if (BLOCKED_RESOURCE_TYPES.has(resourceType.toLowerCase())) {
    return true;
  }
  return BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export function isGraphqlResponseUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return GRAPHQL_ENDPOINT_PATTERNS.some((segment) => lower.includes(segment));
}

export function resolveChromiumExecutablePath(explicitPath?: string): string | undefined {
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  for (const candidate of CHROMIUM_CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface BrowserPoolLike {
  acquireContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}

export class WarmBrowserPool implements BrowserPoolLike {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly executablePath?: string;

  constructor(options?: { executablePath?: string }) {
    this.executablePath = options?.executablePath;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    if (this.launching) {
      return this.launching;
    }

    const executablePath = resolveChromiumExecutablePath(this.executablePath);
    this.launching = chromium.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--mute-audio',
      ],
    });

    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  async acquireContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    return browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'vi-VN',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
  }

  async close(): Promise<void> {
    const current = this.browser;
    this.browser = null;
    if (current) {
      await current.close();
    }
  }
}

export interface Tier2PlaywrightOptions {
  timeoutMs?: number;
  browserPool?: BrowserPoolLike;
  executablePath?: string;
}

export class Tier2PlaywrightScraper {
  private readonly timeoutMs: number;
  private readonly browserPool: BrowserPoolLike;
  private readonly ownsPool: boolean;

  constructor(options?: Tier2PlaywrightOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIER2_TIMEOUT_MS;
    if (options?.browserPool) {
      this.browserPool = options.browserPool;
      this.ownsPool = false;
    } else {
      this.browserPool = new WarmBrowserPool({
        executablePath: options?.executablePath,
      });
      this.ownsPool = true;
    }
  }

  async scrape(canonicalUrl: string, shortcode: string): Promise<RawScrapePayload> {
    const context = await this.browserPool.acquireContext();
    let page: Page | null = null;

    try {
      await context.route('**/*', async (route: Route) => {
        const req = route.request();
        if (shouldBlockPlaywrightRequest(req.resourceType(), req.url())) {
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });

      page = await context.newPage();
      const collectedPosts: RawMetaPostNode[] = [];
      const responseTasks: Array<Promise<void>> = [];

      page.on('response', (response) => {
        const url = response.url();
        if (!isGraphqlResponseUrl(url)) {
          return;
        }
        const task = (async () => {
          try {
            if (response.status() >= 200 && response.status() < 300) {
              const json: unknown = await response.json();
              const extracted = extractThreadFromGraphql(json, shortcode);
              if (extracted) {
                collectedPosts.push(extracted.rootPost, ...extracted.replies);
              }
            }
          } catch {
            // Non-JSON or aborted GraphQL response; ignore safely
          }
        })();
        responseTasks.push(task);
      });

      const navResponse = await page.goto(canonicalUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeoutMs,
      });

      if (navResponse) {
        const statusErr = mapHttpStatusToScraperError(navResponse.status(), canonicalUrl);
        if (statusErr) {
          throw statusErr;
        }
      }

      // Give GraphQL hydration a brief window within remaining budget
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(3_000, this.timeoutMs),
      }).catch(() => undefined);

      await Promise.allSettled(responseTasks);

      const finalUrl = page.url();
      const html = await page.content();

      const blockedCode = detectBlockedUrlOrHtml(finalUrl, html);
      if (blockedCode) {
        throw new ScraperError(blockedCode, {
          details: { finalUrl, tier: 'tier2_playwright' },
        });
      }

      // Merge GraphQL intercepted posts + DOM Relay scripts
      const domExtracted = extractThreadFromHtml(html, shortcode);
      if (domExtracted) {
        collectedPosts.push(domExtracted.rootPost, ...domExtracted.replies);
      }

      const merged = buildRawScrapePayload(collectedPosts, shortcode);
      if (!merged) {
        throw new ScraperError('ERR_POST_NOT_FOUND', {
          message:
            'Không thể trích xuất dữ liệu bài viết từ Threads sau cả hai tầng thu thập (SSR & GraphQL).',
          details: { canonicalUrl, shortcode },
        });
      }

      return merged;
    } catch (error) {
      if (isScraperError(error)) {
        throw error;
      }
      if (isTimeoutError(error)) {
        throw new ScraperError('ERR_SCRAPER_TIMEOUT', { cause: error });
      }
      throw new ScraperError('ERR_POST_NOT_FOUND', {
        message: `Lỗi tầng Playwright khi thu thập bài viết: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    } finally {
      if (page) {
        await page.close().catch(() => undefined);
      }
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.browserPool.close();
    }
  }
}
