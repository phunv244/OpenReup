import { describe, expect, it } from 'vitest';
import {
  META_MEDIA_TYPE_IMAGE,
  META_MEDIA_TYPE_VIDEO,
  NormalizedThreadsPostSchema,
  ThreadsPostUrlSchema,
  classifyCommentState,
  classifyTextLengthState,
  isAllowedMediaCdnUrl,
  paginatePostText,
  parseThreadsUrl,
  sanitizeMediaItems,
  type NormalizedThreadsPost,
} from '../../src/contracts/index.js';

function makeWords(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i + 1}`).join(' ');
}

function makeBasePost(overrides: Partial<NormalizedThreadsPost> = {}): NormalizedThreadsPost {
  const now = 1764176400;
  return {
    id: 'post_01',
    shortcode: 'C8AbCdEf123',
    sourceUrl: 'https://www.threads.net/@uyentich19/post/C8AbCdEf123',
    authorHandle: 'uyentich19',
    authorDisplayName: 'Uyen Tich',
    isVerified: false,
    authorAvatarPath: '/tmp/videothreads/job_1/images/avatar.webp',
    postedDisplayDate: '11/02',
    rawText: makeWords(50),
    images: [],
    strippedVideoCount: 0,
    metrics: { likes: 1240, replies: 85, reposts: 42, shares: 19 },
    topReplies: [],
    textLengthState: 'ST-LEN-02',
    mediaState: 'ST-MED-01',
    commentState: 'ST-COM-01',
    expiresAt: now + 21600,
    createdAt: now,
    ...overrides,
  };
}

describe('Threads URL validation & SSRF protection (ST-ERR-01)', () => {
  it('accepts valid threads.net and threads.com post URLs', () => {
    const netUrl = parseThreadsUrl('https://www.threads.net/@uyentich19/post/C8AbCdEf123');
    expect(netUrl).toEqual({
      canonicalUrl: 'https://www.threads.net/@uyentich19/post/C8AbCdEf123',
      shortcode: 'C8AbCdEf123',
      authorHandle: 'uyentich19',
    });

    const comUrl = parseThreadsUrl('https://threads.com/@dev.user/post/XyZ_987/');
    expect(comUrl?.shortcode).toBe('XyZ_987');
    expect(comUrl?.authorHandle).toBe('dev.user');

    const shortUrl = parseThreadsUrl('https://www.threads.net/t/C8AbCdEf123');
    expect(shortUrl?.shortcode).toBe('C8AbCdEf123');
    expect(ThreadsPostUrlSchema.safeParse('https://threads.net/@a/post/123').success).toBe(true);
  });

  it('rejects non-Threads domains, http protocol, and SSRF targets', () => {
    const invalidUrls = [
      'http://www.threads.net/@user/post/123',
      'https://www.facebook.com/user/posts/123',
      'https://www.tiktok.com/@user/video/123',
      'https://127.0.0.1/@user/post/123',
      'https://169.254.169.254/latest/meta-data/',
      'https://www.threads.net/',
      'not-a-url',
    ];

    for (const url of invalidUrls) {
      expect(ThreadsPostUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it('whitelists only Meta CDN domains for media downloads', () => {
    expect(isAllowedMediaCdnUrl('https://scontent.cdninstagram.com/v/t51.2885-15/img.jpg')).toBe(
      true,
    );
    expect(isAllowedMediaCdnUrl('https://scontent-hkg1-1.xx.fbcdn.net/v/img.jpg')).toBe(true);
    expect(isAllowedMediaCdnUrl('http://scontent.cdninstagram.com/img.jpg')).toBe(false);
    expect(isAllowedMediaCdnUrl('https://evil.com/cdninstagram.com/img.jpg')).toBe(false);
    expect(isAllowedMediaCdnUrl('https://127.0.0.1/img.jpg')).toBe(false);
  });
});

describe('Text Length Dynamics (ST-LEN-01..05) & Smart Pagination', () => {
  it('classifies all 5 text length states accurately', () => {
    expect(classifyTextLengthState(makeWords(12))).toBe('ST-LEN-01');
    expect(classifyTextLengthState(makeWords(60))).toBe('ST-LEN-02');
    expect(classifyTextLengthState(makeWords(180))).toBe('ST-LEN-03');
    expect(classifyTextLengthState(makeWords(400))).toBe('ST-LEN-04');
    expect(classifyTextLengthState(makeWords(550))).toBe('ST-LEN-05');
  });

  it('paginates long text-only posts into <=280 char pages and caps mega stories at 3 pages', () => {
    const longText = Array.from(
      { length: 8 },
      (_, i) => `Câu chuyện văn phòng số ${i + 1} rất dài và gây tranh cãi kịch liệt trên Threads hôm nay.`,
    ).join(' ');

    const pages = paginatePostText(longText, { hasImages: false, maxPages: 3 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThanOrEqual(3);
    for (const page of pages.slice(0, -1)) {
      expect(page.length).toBeLessThanOrEqual(280);
    }
  });

  it('uses tighter 160-char page limit when post includes images', () => {
    const textWithImg =
      'Hôm nay đi làm gặp sếp bắt tăng ca không lương. Mình hỏi thẳng có tính OT không thì sếp bảo làm vì đam mê. Mọi người cho ý kiến xem có nên nghỉ việc ngay lập tức không ạ?';
    const pages = paginatePostText(textWithImg, { hasImages: true });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.length).toBeLessThanOrEqual(160);
  });
});

describe('Media Dynamics (ST-MED-01..06) & Strict No-Video Policy', () => {
  it('handles ST-MED-01 (text-only)', () => {
    const result = sanitizeMediaItems([]);
    expect(result).toEqual({
      images: [],
      strippedVideoCount: 0,
      failedImageCount: 0,
      mediaState: 'ST-MED-01',
    });
  });

  it('handles ST-MED-02 (single 1:1 image) and ST-MED-03 (single vertical 4:5 image)', () => {
    const square = sanitizeMediaItems([
      { mediaType: META_MEDIA_TYPE_IMAGE, src: '/tmp/a.webp', width: 1080, height: 1080 },
    ]);
    expect(square.mediaState).toBe('ST-MED-02');
    expect(square.images).toHaveLength(1);

    const vertical = sanitizeMediaItems([
      { mediaType: META_MEDIA_TYPE_IMAGE, src: '/tmp/b.webp', width: 1080, height: 1350 },
    ]);
    expect(vertical.mediaState).toBe('ST-MED-03');
    expect(vertical.images).toHaveLength(1);
  });

  it('handles ST-MED-04 (carousel 2-10 images), strips embedded videos, and caps at 6 images', () => {
    const rawItems = [
      ...Array.from({ length: 8 }, (_, i) => ({
        mediaType: META_MEDIA_TYPE_IMAGE,
        src: `/tmp/img_${i}.webp`,
        width: 1080,
        height: 1080,
      })),
      { mediaType: META_MEDIA_TYPE_VIDEO, hasVideoVersions: true },
      { mediaType: META_MEDIA_TYPE_IMAGE, hasVideoVersions: true, src: '/tmp/trick.mp4' },
    ];

    const result = sanitizeMediaItems(rawItems);
    expect(result.mediaState).toBe('ST-MED-04');
    expect(result.images).toHaveLength(6);
    expect(result.strippedVideoCount).toBe(2);
    expect(result.images.every((img) => img.kind === 'image')).toBe(true);
  });

  it('handles ST-MED-05 (video post with caption): drops video safely without crashing', () => {
    const result = sanitizeMediaItems([
      { mediaType: META_MEDIA_TYPE_VIDEO, hasVideoVersions: true },
    ]);
    expect(result.mediaState).toBe('ST-MED-05');
    expect(result.images).toHaveLength(0);
    expect(result.strippedVideoCount).toBe(1);

    const post = makeBasePost({
      rawText: 'Bài viết có video nhưng vẫn có caption đủ nghĩa',
      images: result.images,
      strippedVideoCount: result.strippedVideoCount,
      mediaState: result.mediaState,
    });
    expect(NormalizedThreadsPostSchema.safeParse(post).success).toBe(true);
  });

  it('rejects video-only post with empty text (ERR_VIDEO_ONLY_POST)', () => {
    const videoOnlyPost = makeBasePost({
      rawText: '   ',
      images: [],
      strippedVideoCount: 1,
      mediaState: 'ST-MED-05',
    });
    const parsed = NormalizedThreadsPostSchema.safeParse(videoOnlyPost);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('ERR_VIDEO_ONLY_POST');
    }
  });

  it('handles ST-MED-06 (failed/corrupt image): falls back safely to empty images array', () => {
    const result = sanitizeMediaItems([
      {
        mediaType: META_MEDIA_TYPE_IMAGE,
        src: '/tmp/broken.webp',
        width: 1080,
        height: 1080,
        imageFailed: true,
      },
    ]);
    expect(result.mediaState).toBe('ST-MED-06');
    expect(result.images).toHaveLength(0);
    expect(result.failedImageCount).toBe(1);
  });
});

describe('Comment Dynamics (ST-COM-01..04)', () => {
  it('classifies all 4 comment states accurately', () => {
    expect(classifyCommentState(0)).toBe('ST-COM-01');
    expect(classifyCommentState(1)).toBe('ST-COM-02');
    expect(classifyCommentState(2)).toBe('ST-COM-02');
    expect(classifyCommentState(5)).toBe('ST-COM-03');
    expect(classifyCommentState(50)).toBe('ST-COM-03');
    expect(classifyCommentState(120)).toBe('ST-COM-04');
  });
});
