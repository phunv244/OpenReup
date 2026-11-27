import {
  ScraperError,
  isTimeoutError,
  mapHttpStatusToScraperError,
} from './errors.js';
import { detectBlockedUrlOrHtml, extractThreadFromHtml } from './relay-parser.js';
import type { FetchLike, RawScrapePayload } from './types.js';

export const DEFAULT_TIER1_TIMEOUT_MS = 10_000;
export const DEFAULT_MIN_REPLIES_FOR_TIER1 = 5;
export const DEFAULT_RETRY_503_MAX_ATTEMPTS = 1;
export const DEFAULT_RETRY_503_DELAY_MS = 500;

export interface Tier1SsrOptions {
  timeoutMs?: number;
  minRepliesForTier1?: number;
  max503Retries?: number;
  retry503DelayMs?: number;
  fetchFn?: FetchLike;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface Tier1ScrapeOutcome {
  payload: RawScrapePayload | null;
  needsTier2Fallback: boolean;
  fallbackReason?: string;
}

const DESKTOP_SSR_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export class Tier1SsrScraper {
  private readonly timeoutMs: number;
  private readonly minRepliesForTier1: number;
  private readonly max503Retries: number;
  private readonly retry503DelayMs: number;
  private readonly fetchFn: FetchLike;

  constructor(options?: Tier1SsrOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIER1_TIMEOUT_MS;
    this.minRepliesForTier1 =
      options?.minRepliesForTier1 ?? DEFAULT_MIN_REPLIES_FOR_TIER1;
    this.max503Retries = options?.max503Retries ?? DEFAULT_RETRY_503_MAX_ATTEMPTS;
    this.retry503DelayMs = options?.retry503DelayMs ?? DEFAULT_RETRY_503_DELAY_MS;
    this.fetchFn = options?.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async scrape(canonicalUrl: string, shortcode: string): Promise<Tier1ScrapeOutcome> {
    let response: Response | null = null;
    const maxAttempts = this.max503Retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await this.fetchFn(canonicalUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: DESKTOP_SSR_HEADERS,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new ScraperError('ERR_SCRAPER_TIMEOUT', { cause: error });
        }
        return {
          payload: null,
          needsTier2Fallback: true,
          fallbackReason: `Tier 1 network error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (response.status === 503 && attempt < maxAttempts) {
        await sleep(this.retry503DelayMs);
        continue;
      }

      break;
    }

    if (!response) {
      return {
        payload: null,
        needsTier2Fallback: true,
        fallbackReason: 'Tier 1 returned no HTTP response',
      };
    }

    // Handle 3xx redirects explicitly to catch login/checkpoint redirects immediately
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      const blockedCode = detectBlockedUrlOrHtml(location);
      if (blockedCode) {
        throw new ScraperError(blockedCode, {
          httpStatus: response.status,
          details: { location },
        });
      }
      return {
        payload: null,
        needsTier2Fallback: true,
        fallbackReason: `Redirected (${response.status}) to ${location}`,
      };
    }

    const statusError = mapHttpStatusToScraperError(response.status, canonicalUrl);
    if (statusError) {
      throw statusError;
    }

    if (!response.ok) {
      return {
        payload: null,
        needsTier2Fallback: true,
        fallbackReason: `Unexpected HTTP status ${response.status}`,
      };
    }

    const finalUrl = response.url || canonicalUrl;
    const html = await response.text();

    const blockedCode = detectBlockedUrlOrHtml(finalUrl, html);
    if (blockedCode) {
      throw new ScraperError(blockedCode, {
        httpStatus: response.status,
        details: { finalUrl },
      });
    }

    const payload = extractThreadFromHtml(html, shortcode);
    if (!payload) {
      return {
        payload: null,
        needsTier2Fallback: true,
        fallbackReason: 'SSR HTML did not contain Relay JSON thread_items (JS hydration required)',
      };
    }

    const expectedReplies = payload.rootPost.text_post_app_info?.direct_reply_count ?? 0;
    const targetReplyThreshold = Math.min(expectedReplies, this.minRepliesForTier1);

    if (targetReplyThreshold > 0 && payload.replies.length < targetReplyThreshold) {
      return {
        payload,
        needsTier2Fallback: true,
        fallbackReason: `SSR returned ${payload.replies.length}/${expectedReplies} replies; escalating to Tier 2`,
      };
    }

    return {
      payload,
      needsTier2Fallback: false,
    };
  }
}
