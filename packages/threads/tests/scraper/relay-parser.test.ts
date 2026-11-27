import { describe, expect, it } from 'vitest';
import {
  detectBlockedUrlOrHtml,
  extractThreadFromGraphql,
  extractThreadFromHtml,
  selectBestImageCandidate,
  shouldBlockPlaywrightRequest,
} from '../../src/scraper/index.js';

describe('Relay SSR & GraphQL Parser', () => {
  it('extracts root post and top 20 sorted replies from <script type="application/json" data-sjs>', () => {
    const replies = Array.from({ length: 25 }, (_, i) => ({
      post: {
        pk: `reply-${i + 1}`,
        code: `REP_${i + 1}`,
        user: { username: `commenter_${i + 1}` },
        caption: { text: `Bình luận số ${i + 1}` },
        like_count: (i + 1) * 10,
        media_type: 19,
      },
    }));

    const ssrJson = {
      require: [
        [
          'ScheduledServerJS',
          'handle',
          null,
          [
            {
              __bbox: {
                result: {
                  data: {
                    data: {
                      edges: [
                        {
                          node: {
                            thread_items: [
                              {
                                post: {
                                  pk: 'root-100',
                                  code: 'C9TEST001',
                                  user: { username: 'uyentich19', full_name: 'Uyen Tich' },
                                  caption: { text: 'Bài viết gốc trên Threads' },
                                  like_count: 1500,
                                  media_type: 19,
                                  text_post_app_info: { direct_reply_count: 120 },
                                },
                              },
                            ],
                          },
                        },
                        ...replies.map((r) => ({ node: { thread_items: [r] } })),
                      ],
                    },
                  },
                },
              },
            },
          ],
        ],
      ],
    };

    const html = `<!doctype html><html><body><script type="application/json" data-sjs>${JSON.stringify(
      ssrJson,
    )}</script></body></html>`;

    const extracted = extractThreadFromHtml(html, 'C9TEST001');
    expect(extracted).not.toBeNull();
    expect(extracted?.rootPost.code).toBe('C9TEST001');
    expect(extracted?.replies).toHaveLength(20); // Capped at MAX_STORED_REPLIES = 20
    expect(extracted?.replies[0]?.like_count).toBe(250); // Highest likes first
    expect(extracted?.totalReplyCount).toBe(120);
  });

  it('extracts thread payload from GraphQL JSON response', () => {
    const graphql = {
      data: {
        data: {
          containing_thread: {
            thread_items: [
              {
                post: {
                  pk: 'root-200',
                  code: 'GQL_POST_1',
                  user: { username: 'creator_vn' },
                  caption: { text: 'Nội dung từ GraphQL interceptor' },
                  like_count: 420,
                  media_type: 19,
                },
              },
            ],
          },
          reply_threads: [
            {
              thread_items: [
                {
                  post: {
                    pk: 'rep-201',
                    code: 'GQL_REP_1',
                    user: { username: 'fan_1' },
                    caption: { text: 'Quá chuẩn luôn!' },
                    like_count: 88,
                    media_type: 19,
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const extracted = extractThreadFromGraphql(graphql, 'GQL_POST_1');
    expect(extracted).not.toBeNull();
    expect(extracted?.rootPost.user?.username).toBe('creator_vn');
    expect(extracted?.replies).toHaveLength(1);
    expect(extracted?.replies[0]?.caption?.text).toBe('Quá chuẩn luôn!');
  });

  it('selects image candidate closest to 1080px width', () => {
    const best = selectBestImageCandidate([
      { url: 'https://scontent.cdninstagram.com/small.jpg', width: 320, height: 320 },
      { url: 'https://scontent.cdninstagram.com/hd.jpg', width: 1080, height: 1080 },
      { url: 'https://scontent.cdninstagram.com/uhd.jpg', width: 2048, height: 2048 },
    ]);
    expect(best?.url).toBe('https://scontent.cdninstagram.com/hd.jpg');
  });

  it('detects private login walls, checkpoint/CAPTCHA, and 404 pages', () => {
    expect(detectBlockedUrlOrHtml('https://www.threads.net/login?next=/@priv/post/1')).toBe(
      'ERR_PRIVATE_ACCOUNT',
    );
    expect(detectBlockedUrlOrHtml('https://www.threads.net/challenge/')).toBe('ERR_RATE_LIMITED');
    expect(
      detectBlockedUrlOrHtml(
        'https://www.threads.net/@u/post/1',
        '<div class="cf-turnstile">Verify human</div>',
      ),
    ).toBe('ERR_RATE_LIMITED');
    expect(
      detectBlockedUrlOrHtml(
        'https://www.threads.net/@u/post/1',
        '<p>This account is private</p>',
      ),
    ).toBe('ERR_PRIVATE_ACCOUNT');
    expect(
      detectBlockedUrlOrHtml(
        'https://www.threads.net/@u/post/1',
        "<p>Sorry, this page isn't available.</p>",
      ),
    ).toBe('ERR_POST_NOT_FOUND');
  });

  it('blocks video, media, fonts, stylesheets, and analytics requests in Tier 2 Playwright', () => {
    expect(shouldBlockPlaywrightRequest('media', 'https://video.cdninstagram.com/v/a.mp4')).toBe(
      true,
    );
    expect(shouldBlockPlaywrightRequest('other', 'https://scontent.fbcdn.net/stream.m3u8')).toBe(
      true,
    );
    expect(shouldBlockPlaywrightRequest('font', 'https://static.cdninstagram.com/inter.woff2')).toBe(
      true,
    );
    expect(shouldBlockPlaywrightRequest('stylesheet', 'https://static.cdninstagram.com/app.css')).toBe(
      true,
    );
    expect(shouldBlockPlaywrightRequest('xhr', 'https://www.threads.net/api/graphql')).toBe(false);
    expect(shouldBlockPlaywrightRequest('document', 'https://www.threads.net/@u/post/1')).toBe(
      false,
    );
  });
});
