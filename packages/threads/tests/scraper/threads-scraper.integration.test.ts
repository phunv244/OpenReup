import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Request as PwRequest, Response as PwResponse, Route } from 'playwright-core';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NormalizedThreadsPostSchema } from '../../src/contracts/index.js';
import { PostRepository, openDatabase, runMigrations } from '../../src/db/index.js';
import {
  ScraperError,
  ThreadsScraperService,
  type BrowserPoolLike,
  type RawMetaPostNode,
} from '../../src/scraper/index.js';

function wrapInSsrHtml(nodes: RawMetaPostNode[]): string {
  const payload = {
    data: {
      data: {
        edges: nodes.map((post) => ({
          node: { thread_items: [{ post }] },
        })),
      },
    },
  };
  return `<!doctype html><html><head><title>Threads</title></head><body><script type="application/json" data-sjs>${JSON.stringify(
    payload,
  )}</script></body></html>`;
}

describe('ThreadsScraperService Integration Tests (Mock HTTP Server + Sharp + SQLite)', () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let validSquarePng: Buffer;
  let validTallPng: Buffer;
  let requestLog: string[] = [];

  const routeHandlers = new Map<
    string,
    (req: IncomingMessage, res: ServerResponse) => void
  >();

  beforeAll(async () => {
    validSquarePng = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: { r: 30, g: 144, b: 255 } },
    })
      .png()
      .toBuffer();

    validTallPng = await sharp({
      create: { width: 1000, height: 1600, channels: 3, background: { r: 220, g: 80, b: 120 } },
    })
      .png()
      .toBuffer();

    server = createServer((req, res) => {
      const reqPath = req.url ?? '/';
      requestLog.push(reqPath);
      const handler = routeHandlers.get(reqPath);
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind local mock server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vt-scraper-int-'));
    requestLog = [];
    routeHandlers.clear();

    // Standard static image endpoints on mock server
    routeHandlers.set('/img/square.png', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(validSquarePng);
    });
    routeHandlers.set('/img/tall.png', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(validTallPng);
    });
    routeHandlers.set('/img/avatar.png', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(validSquarePng);
    });
    routeHandlers.set('/img/corrupt.jpg', (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end('corrupted-binary-payload');
    });
    routeHandlers.set('/video/forbidden.mp4', (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end('MUST_NEVER_BE_FETCHED');
    });
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  /**
   * Routes canonical `https://www.threads.net/...` requests to our local mock HTTP server
   * while allowing local image fetches (`allowLocalTestHosts: true`).
   */
  function createMockRoutedFetch() {
    return (input: string | URL, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === 'string' ? input : input.toString();
      const parsed = new URL(raw);
      if (parsed.hostname.endsWith('threads.net') || parsed.hostname.endsWith('threads.com')) {
        return fetch(`${baseUrl}${parsed.pathname}${parsed.search}`, init);
      }
      return fetch(raw, init);
    };
  }

  it('scrapes via Tier 1 SSR, compresses image via Sharp, validates Zod schema, and caches in SQLite (6h TTL)', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const postRepo = new PostRepository(db);

    const rootNode: RawMetaPostNode = {
      pk: '1001',
      code: 'HAPPY_01',
      user: {
        username: 'uyentich19',
        full_name: 'Uyên Tích',
        is_verified: true,
        profile_pic_url: `${baseUrl}/img/avatar.png`,
      },
      caption: {
        text: 'Đi làm lương 9tr2 mà sếp bắt tăng ca không lương cuối tuần, mọi người thấy có nên nghỉ việc ngay không ạ? Thật sự quá mệt mỏi luôn rồi.',
      },
      taken_at: 1732500000,
      media_type: 1,
      image_versions2: {
        candidates: [{ url: `${baseUrl}/img/square.png`, width: 1200, height: 1200 }],
      },
      like_count: 2340,
      text_post_app_info: { direct_reply_count: 5, repost_count: 42, share_count: 18 },
    };

    const replyNodes: RawMetaPostNode[] = Array.from({ length: 5 }, (_, idx) => ({
      pk: `200${idx}`,
      code: `REP_${idx}`,
      user: {
        username: `user_${idx}`,
        profile_pic_url: `${baseUrl}/img/avatar.png`,
      },
      caption: { text: `Nghỉ gấp đi bạn ơi, bình luận số ${idx + 1}!` },
      taken_at: 1732500600 + idx * 60,
      like_count: 100 + idx * 50,
      media_type: 19,
    }));

    routeHandlers.set('/@uyentich19/post/HAPPY_01', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(wrapInSsrHtml([rootNode, ...replyNodes]));
    });

    const service = new ThreadsScraperService({
      cacheDir,
      postRepository: postRepo,
      fetchFn: createMockRoutedFetch(),
      allowLocalTestHosts: true,
      enableTier2Fallback: false,
    });

    const first = await service.scrapePost('https://www.threads.net/@uyentich19/post/HAPPY_01', {
      nowEpochSec: 1732510000,
    });

    expect(first.source).toBe('tier1_ssr');
    expect(() => NormalizedThreadsPostSchema.parse(first.post)).not.toThrow();
    expect(first.post.shortcode).toBe('HAPPY_01');
    expect(first.post.authorHandle).toBe('uyentich19');
    expect(first.post.images).toHaveLength(1);
    expect(first.post.images[0]?.width).toBe(1080);
    expect(first.post.images[0]?.height).toBe(1080);
    expect(first.post.images[0]?.src.endsWith('.webp')).toBe(true);
    expect(first.post.mediaState).toBe('ST-MED-02');
    expect(first.post.commentState).toBe('ST-COM-03');
    expect(first.post.strippedVideoCount).toBe(0);
    expect(first.post.topReplies).toHaveLength(5);
    expect(first.post.topReplies[0]?.likes).toBe(300);

    // Second call must hit SQLite 6h cache with 0 new HTTP requests
    const reqCountBeforeCache = requestLog.length;
    const second = await service.scrapePost('https://www.threads.net/@uyentich19/post/HAPPY_01', {
      nowEpochSec: 1732510100,
    });
    expect(second.source).toBe('cache');
    expect(requestLog.length).toBe(reqCountBeforeCache);

    db.close();
  });

  it('enforces Strict No-Video Policy: drops media_type=2 with text (ST-MED-05) and NEVER downloads video', async () => {
    const videoWithText: RawMetaPostNode = {
      pk: '3001',
      code: 'VID_TEXT_01',
      user: { username: 'creator_vid' },
      caption: { text: 'Bài viết có đính kèm video nhưng vẫn có chữ rất hay để đọc!' },
      taken_at: 1732500000,
      media_type: 2,
      video_versions: [{ url: `${baseUrl}/video/forbidden.mp4`, width: 1080, height: 1920 }],
      like_count: 500,
      text_post_app_info: { direct_reply_count: 0 },
    };

    routeHandlers.set('/@creator_vid/post/VID_TEXT_01', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(wrapInSsrHtml([videoWithText]));
    });

    const service = new ThreadsScraperService({
      cacheDir,
      fetchFn: createMockRoutedFetch(),
      allowLocalTestHosts: true,
      enableTier2Fallback: false,
    });

    const result = await service.scrapePost('https://www.threads.net/@creator_vid/post/VID_TEXT_01');
    expect(result.post.images).toHaveLength(0);
    expect(result.post.strippedVideoCount).toBe(1);
    expect(result.post.mediaState).toBe('ST-MED-05');
    expect(result.post.commentState).toBe('ST-COM-01');
    expect(requestLog).not.toContain('/video/forbidden.mp4');
  });

  it('throws ERR_VIDEO_ONLY_POST when post contains only video and no text', async () => {
    const videoOnly: RawMetaPostNode = {
      pk: '3002',
      code: 'VID_ONLY_01',
      user: { username: 'creator_vid' },
      caption: { text: '   ' },
      taken_at: 1732500000,
      media_type: 2,
      video_versions: [{ url: `${baseUrl}/video/forbidden.mp4`, width: 1080, height: 1920 }],
      like_count: 120,
    };

    routeHandlers.set('/@creator_vid/post/VID_ONLY_01', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(wrapInSsrHtml([videoOnly]));
    });

    const service = new ThreadsScraperService({
      cacheDir,
      fetchFn: createMockRoutedFetch(),
      allowLocalTestHosts: true,
      enableTier2Fallback: false,
    });

    await expect(
      service.scrapePost('https://www.threads.net/@creator_vid/post/VID_ONLY_01'),
    ).rejects.toMatchObject({
      code: 'ERR_VIDEO_ONLY_POST',
    });
    expect(requestLog).not.toContain('/video/forbidden.mp4');
  });

  it('strips videos from mixed carousel (media_type=8), keeps static images, and drops comment videos', async () => {
    const mixedCarousel: RawMetaPostNode = {
      pk: '4001',
      code: 'CAROUSEL_01',
      user: { username: 'album_user' },
      caption: { text: 'Album vừa có ảnh vừa có video nè mọi người' },
      taken_at: 1732500000,
      media_type: 8,
      carousel_media: [
        {
          media_type: 1,
          image_versions2: { candidates: [{ url: `${baseUrl}/img/square.png`, width: 1200, height: 1200 }] },
        },
        {
          media_type: 2,
          video_versions: [{ url: `${baseUrl}/video/forbidden.mp4` }],
        },
        {
          media_type: 1,
          image_versions2: { candidates: [{ url: `${baseUrl}/img/tall.png`, width: 1000, height: 1600 }] },
        },
        {
          media_type: 2,
          video_versions: [{ url: `${baseUrl}/video/forbidden.mp4` }],
        },
      ],
      like_count: 890,
      text_post_app_info: { direct_reply_count: 2 },
    };

    const replyWithVideo: RawMetaPostNode = {
      pk: '4002',
      code: 'REP_VID',
      user: { username: 'comment_vid' },
      caption: { text: 'Comment kèm video phải bỏ video đi' },
      media_type: 2,
      video_versions: [{ url: `${baseUrl}/video/forbidden.mp4` }],
      like_count: 55,
    };

    const replyWithImage: RawMetaPostNode = {
      pk: '4003',
      code: 'REP_IMG',
      user: { username: 'comment_img' },
      caption: { text: 'Comment kèm ảnh meme giữ nguyên ảnh' },
      media_type: 1,
      image_versions2: { candidates: [{ url: `${baseUrl}/img/square.png`, width: 1200, height: 1200 }] },
      like_count: 90,
    };

    routeHandlers.set('/@album_user/post/CAROUSEL_01', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(wrapInSsrHtml([mixedCarousel, replyWithVideo, replyWithImage]));
    });

    const service = new ThreadsScraperService({
      cacheDir,
      fetchFn: createMockRoutedFetch(),
      allowLocalTestHosts: true,
      enableTier2Fallback: false,
    });

    const res = await service.scrapePost('https://www.threads.net/@album_user/post/CAROUSEL_01');
    expect(res.post.images).toHaveLength(2);
    expect(res.post.strippedVideoCount).toBe(2);
    expect(res.post.mediaState).toBe('ST-MED-04');
    expect(res.post.topReplies).toHaveLength(2);
    expect(res.post.topReplies[0]?.image?.kind).toBe('image');
    expect(res.post.topReplies[1]?.strippedVideoCount).toBe(1);
    expect(res.post.topReplies[1]?.image).toBeUndefined();
    expect(requestLog).not.toContain('/video/forbidden.mp4');
  });

  it('falls back safely to ST-MED-06 when post image is corrupt/broken without crashing', async () => {
    const corruptPost: RawMetaPostNode = {
      pk: '5001',
      code: 'CORRUPT_IMG_01',
      user: { username: 'broken_img_user' },
      caption: { text: 'Bài viết có ảnh bị lỗi link vẫn phải chạy bình thường' },
      taken_at: 1732500000,
      media_type: 1,
      image_versions2: {
        candidates: [{ url: `${baseUrl}/img/corrupt.jpg`, width: 800, height: 800 }],
      },
      like_count: 100,
    };

    routeHandlers.set('/@broken_img_user/post/CORRUPT_IMG_01', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(wrapInSsrHtml([corruptPost]));
    });

    const service = new ThreadsScraperService({
      cacheDir,
      fetchFn: createMockRoutedFetch(),
      allowLocalTestHosts: true,
      enableTier2Fallback: false,
    });

    const res = await service.scrapePost(
      'https://www.threads.net/@broken_img_user/post/CORRUPT_IMG_01',
    );
    expect(res.post.images).toHaveLength(0);
    expect(res.post.mediaState).toBe('ST-MED-06');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('escalates to Tier 2 Playwright + GraphQL Interceptor when Tier 1 SSR returns JS-only shell', async () => {
    routeHandlers.set('/@js_only/post/TIER2_01', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><div id="mount">Loading...</div></body></html>');
    });

    const abortedUrls: string[] = [];
    const continuedUrls: string[] = [];

    const mockBrowserPool: BrowserPoolLike = {
      acquireContext: () => {
        let routeHandler: ((route: Route) => Promise<void>) | undefined;
        let responseListener: ((res: PwResponse) => void) | undefined;

        const mockPage = {
          on: (event: string, listener: (res: PwResponse) => void) => {
            if (event === 'response') {
              responseListener = listener;
            }
          },
          goto: async (url: string) => {
            // Verify resource blocking via registered route handler
            if (routeHandler) {
              const videoRoute = {
                request: () =>
                  ({
                    resourceType: () => 'media',
                    url: () => 'https://video.cdninstagram.com/clip.mp4',
                  }) as unknown as PwRequest,
                abort: () => {
                  abortedUrls.push('https://video.cdninstagram.com/clip.mp4');
                  return Promise.resolve();
                },
                continue: () => {
                  continuedUrls.push('https://video.cdninstagram.com/clip.mp4');
                  return Promise.resolve();
                },
              } as unknown as Route;
              await routeHandler(videoRoute);

              const gqlRoute = {
                request: () =>
                  ({
                    resourceType: () => 'xhr',
                    url: () => 'https://www.threads.net/api/graphql',
                  }) as unknown as PwRequest,
                abort: () => {
                  abortedUrls.push('https://www.threads.net/api/graphql');
                  return Promise.resolve();
                },
                continue: () => {
                  continuedUrls.push('https://www.threads.net/api/graphql');
                  return Promise.resolve();
                },
              } as unknown as Route;
              await routeHandler(gqlRoute);
            }

            // Simulate intercepted /api/graphql response
            if (responseListener) {
              const fakeGqlResponse = {
                url: () => 'https://www.threads.net/api/graphql',
                status: () => 200,
                json: () =>
                  Promise.resolve({
                    data: {
                      data: {
                        containing_thread: {
                          thread_items: [
                            {
                              post: {
                                pk: '7001',
                                code: 'TIER2_01',
                                user: { username: 'js_only' },
                                caption: { text: 'Dữ liệu trích xuất thành công từ Tier 2 GraphQL!' },
                                taken_at: 1732500000,
                                media_type: 19,
                                like_count: 777,
                                text_post_app_info: { direct_reply_count: 1 },
                              },
                            },
                          ],
                        },
                        reply_threads: [
                          {
                            thread_items: [
                              {
                                post: {
                                  pk: '7002',
                                  code: 'TIER2_REP_1',
                                  user: { username: 'reply_gql' },
                                  caption: { text: 'Tuyệt vời!' },
                                  like_count: 45,
                                  media_type: 19,
                                },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  }),
              } as unknown as PwResponse;
              responseListener(fakeGqlResponse);
            }

            return { status: () => 200, url: () => url };
          },
          waitForLoadState: () => Promise.resolve(undefined),
          url: () => 'https://www.threads.net/@js_only/post/TIER2_01',
          content: () => Promise.resolve('<html><body>Rendered</body></html>'),
          close: () => Promise.resolve(undefined),
        } as unknown as Page;

        return Promise.resolve({
          route: (_pattern: string, handler: (route: Route) => Promise<void>) => {
            routeHandler = handler;
            return Promise.resolve();
          },
          newPage: () => Promise.resolve(mockPage),
          close: () => Promise.resolve(undefined),
        } as unknown as BrowserContext);
      },
      close: () => Promise.resolve(undefined),
    };

    const service = new ThreadsScraperService(
      {
        cacheDir,
        fetchFn: createMockRoutedFetch(),
        allowLocalTestHosts: true,
        enableTier2Fallback: true,
      },
      { browserPool: mockBrowserPool },
    );

    const res = await service.scrapePost('https://www.threads.net/@js_only/post/TIER2_01');
    expect(res.source).toBe('tier2_playwright');
    expect(res.post.rawText).toBe('Dữ liệu trích xuất thành công từ Tier 2 GraphQL!');
    expect(res.post.topReplies).toHaveLength(1);
    expect(abortedUrls).toContain('https://video.cdninstagram.com/clip.mp4');
    expect(continuedUrls).toContain('https://www.threads.net/api/graphql');
  });

  it('maps HTTP 404, 403, login redirect, 429 rate-limit, and timeout to STATE_MATRIX error codes', async () => {
    routeHandlers.set('/@u/post/NOT_FOUND_404', (_req, res) => {
      res.writeHead(404);
      res.end('Not found');
    });
    routeHandlers.set('/@u/post/PRIVATE_403', (_req, res) => {
      res.writeHead(403);
      res.end('Forbidden');
    });
    routeHandlers.set('/@u/post/LOGIN_REDIRECT', (_req, res) => {
      res.writeHead(302, { location: 'https://www.threads.net/login' });
      res.end();
    });
    routeHandlers.set('/@u/post/RATE_LIMIT_429', (_req, res) => {
      res.writeHead(429);
      res.end('Too Many Requests');
    });

    const service = new ThreadsScraperService({
      cacheDir,
      fetchFn: createMockRoutedFetch(),
      allowLocalTestHosts: true,
      enableTier2Fallback: false,
    });

    await expect(
      service.scrapePost('https://www.threads.net/@u/post/NOT_FOUND_404'),
    ).rejects.toMatchObject({ code: 'ERR_POST_NOT_FOUND' });

    await expect(
      service.scrapePost('https://www.threads.net/@u/post/PRIVATE_403'),
    ).rejects.toMatchObject({ code: 'ERR_PRIVATE_ACCOUNT' });

    await expect(
      service.scrapePost('https://www.threads.net/@u/post/LOGIN_REDIRECT'),
    ).rejects.toMatchObject({ code: 'ERR_PRIVATE_ACCOUNT' });

    await expect(
      service.scrapePost('https://www.threads.net/@u/post/RATE_LIMIT_429'),
    ).rejects.toMatchObject({ code: 'ERR_RATE_LIMITED' });

    // Timeout simulation (ST-ERR-07)
    const timeoutFetch = vi.fn(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    });
    const timeoutService = new ThreadsScraperService({
      cacheDir,
      fetchFn: timeoutFetch,
      timeoutMs: 100,
    });

    try {
      await timeoutService.scrapePost('https://www.threads.net/@u/post/SLOW_POST');
      expect.fail('Expected ERR_SCRAPER_TIMEOUT');
    } catch (err) {
      expect(err).toBeInstanceOf(ScraperError);
      expect((err as ScraperError).code).toBe('ERR_SCRAPER_TIMEOUT');
      expect((err as ScraperError).toApiError()).toMatchObject({
        success: false,
        code: 'ERR_SCRAPER_TIMEOUT',
      });
    }
  });
});
