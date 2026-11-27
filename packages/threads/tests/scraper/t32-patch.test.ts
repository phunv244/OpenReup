import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ImageProcessor,
  MAX_IMAGE_DOWNLOAD_CONCURRENCY,
  SHARED_IMAGE_CACHE_SUBDIR,
  Tier1SsrScraper,
  mapRawThreadToNormalizedPost,
  runWithConcurrency,
  type RawScrapePayload,
} from '../../src/scraper/index.js';

describe('T3.2 Patch Verification: Concurrency <= 5, Shared NVMe Cache, HTTP 503 Retry', () => {
  let cacheDir: string;
  let pngBuffer: Buffer;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vt-t32-patch-'));
    pngBuffer = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 60, g: 130, b: 200 } },
    })
      .png()
      .toBuffer();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('caps concurrent image downloads to MAX_IMAGE_DOWNLOAD_CONCURRENCY (5)', async () => {
    expect(MAX_IMAGE_DOWNLOAD_CONCURRENCY).toBe(5);

    let inFlight = 0;
    let maxInFlight = 0;

    const items = Array.from({ length: 14 }, (_, i) => i);
    const out = await runWithConcurrency(items, MAX_IMAGE_DOWNLOAD_CONCURRENCY, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return n * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(out).toHaveLength(14);
    expect(out[13]).toBe(26);
  });

  it('shares NVMe WebP cache across different jobIds under images/shared/{sha256}.webp', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array(pngBuffer), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const processor = new ImageProcessor({
      cacheDir,
      fetchFn,
      verifyDns: false,
    });

    const payload: RawScrapePayload = {
      rootPost: {
        pk: '1',
        code: 'SHARED_01',
        user: {
          username: 'author_a',
          profile_pic_url: 'https://scontent.cdninstagram.com/shared-avatar.png',
        },
        caption: { text: 'Test shared NVMe cache across jobs' },
        media_type: 1,
        image_versions2: {
          candidates: [
            { url: 'https://scontent.cdninstagram.com/shared-photo.png', width: 800, height: 800 },
          ],
        },
        like_count: 100,
      },
      replies: [],
      totalReplyCount: 0,
    };

    const jobA = await mapRawThreadToNormalizedPost(payload, {
      canonicalUrl: 'https://www.threads.net/@author_a/post/SHARED_01',
      shortcode: 'SHARED_01',
      imageProcessor: processor,
      jobId: 'job-A',
    });

    expect(fetchFn).toHaveBeenCalledTimes(2); // 1 avatar + 1 post image
    expect(jobA.post.images[0]?.src).toContain(SHARED_IMAGE_CACHE_SUBDIR);
    expect(jobA.post.images[0]?.src).not.toContain('job-A');

    // Second job with a DIFFERENT jobId must hit the exact same shared cache with 0 network calls
    const jobB = await mapRawThreadToNormalizedPost(payload, {
      canonicalUrl: 'https://www.threads.net/@author_a/post/SHARED_01',
      shortcode: 'SHARED_01',
      imageProcessor: processor,
      jobId: 'job-B',
    });

    expect(fetchFn).toHaveBeenCalledTimes(2); // Zero additional fetches!
    expect(jobB.post.images[0]?.src).toBe(jobA.post.images[0]?.src);
    expect(jobB.post.authorAvatarPath).toBe(jobA.post.authorAvatarPath);
  });

  it('retries HTTP 503 once in Tier 1 SSR before succeeding or falling back to Tier 2 (TC-T3.2-F05)', async () => {
    const validHtml = `<html><body><script type="application/json" data-sjs>${JSON.stringify({
      data: {
        data: {
          edges: [
            {
              node: {
                thread_items: [
                  {
                    post: {
                      pk: '5031',
                      code: 'RETRY_503',
                      user: { username: 'user503' },
                      caption: { text: 'Recovered after 503 retry' },
                      media_type: 19,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    })}</script></body></html>`;

    let callCount = 0;
    const recoverFetch = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(new Response('Service Unavailable', { status: 503 }));
      }
      return Promise.resolve(new Response(validHtml, { status: 200 }));
    });

    const scraperOk = new Tier1SsrScraper({
      fetchFn: recoverFetch,
      max503Retries: 1,
      retry503DelayMs: 10,
    });
    const okOutcome = await scraperOk.scrape(
      'https://www.threads.net/@user503/post/RETRY_503',
      'RETRY_503',
    );
    expect(recoverFetch).toHaveBeenCalledTimes(2);
    expect(okOutcome.needsTier2Fallback).toBe(false);
    expect(okOutcome.payload?.rootPost.code).toBe('RETRY_503');

    // Persistent 503 retries once (2 total attempts) then escalates cleanly to Tier 2
    const always503Fetch = vi.fn(() =>
      Promise.resolve(new Response('Service Unavailable', { status: 503 })),
    );
    const scraperFallback = new Tier1SsrScraper({
      fetchFn: always503Fetch,
      max503Retries: 1,
      retry503DelayMs: 10,
    });
    const fbOutcome = await scraperFallback.scrape(
      'https://www.threads.net/@user503/post/RETRY_503',
      'RETRY_503',
    );
    expect(always503Fetch).toHaveBeenCalledTimes(2);
    expect(fbOutcome.needsTier2Fallback).toBe(true);
    expect(fbOutcome.fallbackReason).toContain('503');
  });
});
