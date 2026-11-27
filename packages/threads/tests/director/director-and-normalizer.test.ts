import { describe, expect, it } from 'vitest';
import { ErrorCodeSchema, type NormalizedThreadsPost } from '../../src/contracts/index.js';
import {
  AIDirectorService,
  DirectorError,
  normalizeVietnameseTtsText,
} from '../../src/director/index.js';

function makeSamplePost(overrides: Partial<NormalizedThreadsPost> = {}): NormalizedThreadsPost {
  return {
    id: 'post_t33_01',
    shortcode: 'T33_TEST',
    sourceUrl: 'https://www.threads.net/@uyentich19/post/T33_TEST',
    authorHandle: 'uyentich19',
    isVerified: true,
    authorAvatarPath: '.cache/images/shared/avatar.webp',
    postedDisplayDate: '11/02',
    rawText: 'Lương 9tr2 ko trừ bhxh nhma sếp bắt OT tới 9h tối ngày 11/02 :))',
    images: [],
    strippedVideoCount: 0,
    metrics: { likes: 1200, replies: 4, reposts: 30, shares: 15 },
    topReplies: [
      {
        id: 'c1',
        authorHandle: 'netizen_1',
        isVerified: false,
        authorAvatarSrc: '.cache/images/shared/a1.webp',
        postedDateLabel: '1h',
        text: 'Chạy ngay đi bạn ơi, ở lại là toang luôn 💀',
        likes: 340,
        strippedVideoCount: 0,
      },
      {
        id: 'c2',
        authorHandle: 'netizen_2',
        isVerified: false,
        authorAvatarSrc: '.cache/images/shared/a2.webp',
        postedDateLabel: '2h',
        text: 'Đọc cmt mà cười muốn xỉu vs sếp bạn luôn á',
        likes: 210,
        strippedVideoCount: 0,
      },
      {
        id: 'c3',
        authorHandle: 'netizen_3',
        isVerified: false,
        authorAvatarSrc: '.cache/images/shared/a3.webp',
        postedDateLabel: '3h',
        text: 'Nyc mình hồi xưa cũng làm chỗ giống vầy, lương 500k tiền thưởng mà bắt làm cả tuần',
        likes: 185,
        strippedVideoCount: 0,
      },
      {
        id: 'c4',
        authorHandle: 'netizen_4',
        isVerified: false,
        authorAvatarSrc: '.cache/images/shared/a4.webp',
        postedDateLabel: '4h',
        text: 'Drama công sở cực gắt luôn mn ơi 🔥',
        likes: 95,
        strippedVideoCount: 0,
      },
    ],
    textLengthState: 'ST-LEN-01',
    mediaState: 'ST-MED-01',
    commentState: 'ST-COM-03',
    expiresAt: 1764200000,
    createdAt: 1764178400,
    ...overrides,
  };
}

describe('T3.3 VN TTS Text Normalizer', () => {
  it('normalizes currency, dates, time, measures, percentages, and VN slang while preserving displayText', () => {
    const input = 'Lương 9tr2 ko trừ bhxh nhma nyc cmt hôm 11/02 đòi 500k lúc 9h30 tối :)) 💀';
    const result = normalizeVietnameseTtsText(input);

    expect(result.displayText).toBe(input);
    expect(result.ttsText).toContain('chín triệu hai');
    expect(result.ttsText).toContain('không trừ bảo hiểm xã hội');
    expect(result.ttsText).toContain('nhưng mà');
    expect(result.ttsText).toContain('người yêu cũ');
    expect(result.ttsText).toContain('bình luận');
    expect(result.ttsText).toContain('ngày mười một tháng hai');
    expect(result.ttsText).toContain('năm trăm nghìn');
    expect(result.ttsText).toContain('chín giờ ba mươi');
    expect(result.ttsText).not.toContain(':))');
    expect(result.ttsText).not.toContain('💀');
    expect(result.replacements.length).toBeGreaterThanOrEqual(8);
  });

  it('normalizes height/measure shorthand and percentages cleanly', () => {
    const result = normalizeVietnameseTtsText('Cao 2m5 mà 100% mn vẫn k tin');
    expect(result.ttsText).toContain('hai mét rưỡi');
    expect(result.ttsText).toContain('một trăm phần trăm');
    expect(result.ttsText).toContain('mọi người');
    expect(result.ttsText).toContain('không tin');
  });

  it('returns empty ttsText for emoji-only input instead of leaking raw emojis', () => {
    const result = normalizeVietnameseTtsText('😂😂😂 💀🤡 :))');
    expect(result.displayText).toBe('😂😂😂 💀🤡 :))');
    expect(result.ttsText).toBe('');
  });
});

describe('T3.3 AI Director (No Scoring)', () => {
  it('generates hookLines, selects 3-5 comments, normalizes ttsText, and assigns SFX/Sticker cues', async () => {
    const director = new AIDirectorService();
    const post = makeSamplePost();
    const script = await director.direct(post, { maxComments: 4 });

    expect(script.postId).toBe(post.id);
    expect(script.hookLines.length).toBeGreaterThanOrEqual(1);
    expect(script.hookLines.length).toBeLessThanOrEqual(2);
    expect(script.selectedCommentIds).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect('scores' in script).toBe(false);
    expect('verdict' in script).toBe(false);

    // Main post preserves original displayText and normalizes ttsText
    const mainSeg = script.segments[0]!;
    expect(mainSeg.kind).toBe('MAIN_POST');
    expect(mainSeg.displayText).toContain('9tr2');
    expect(mainSeg.ttsText).toContain('chín triệu hai');
    expect(mainSeg.audioCues.length).toBeGreaterThan(0);
    expect(mainSeg.visualCues.length).toBeGreaterThan(0);

    // Every contextual cue triggerWord must exist inside ttsText
    for (const seg of script.segments) {
      for (const cue of [...seg.audioCues, ...seg.visualCues]) {
        expect(seg.ttsText.toLowerCase()).toContain(cue.triggerWord.toLowerCase());
      }
    }
  });

  it('appends CTA_OUTRO when post has fewer than 3 comments (ST-COM-01 / ST-COM-02)', async () => {
    const director = new AIDirectorService();
    const post = makeSamplePost({ topReplies: [], commentState: 'ST-COM-01' });
    const script = await director.direct(post);

    expect(script.selectedCommentIds).toHaveLength(0);
    const lastSeg = script.segments[script.segments.length - 1]!;
    expect(lastSeg.kind).toBe('CTA_OUTRO');
  });

  it('blocks policy-violating posts with ERR_POLICY_VIOLATION (ST-ERR-06)', async () => {
    const director = new AIDirectorService();
    const badPost = makeSamplePost({ rawText: 'Bài viết chứa nội dung khiêu dâm vi phạm' });

    await expect(director.direct(badPost)).rejects.toBeInstanceOf(DirectorError);
    await expect(director.direct(badPost)).rejects.toMatchObject({
      code: 'ERR_POLICY_VIOLATION',
    });
  });

  it('matches Vietnamese accented keywords via Unicode word-boundary regex and removes ERR_CONTENT_REJECTED', async () => {
    expect(ErrorCodeSchema.safeParse('ERR_CONTENT_REJECTED').success).toBe(false);

    const director = new AIDirectorService();
    const accentedPost = makeSamplePost({
      rawText: 'Làm vì đam mê nhưng bị bóc lột quá mức luôn!',
      topReplies: [
        {
          id: 'c_acc_1',
          authorHandle: 'u1',
          isVerified: false,
          authorAvatarSrc: '.cache/images/shared/a.webp',
          postedDateLabel: '1h',
          text: 'Thật sự đỉnh cao luôn, nghe mà sốc!',
          likes: 100,
          strippedVideoCount: 0,
        },
        {
          id: 'c_acc_2',
          authorHandle: 'u2',
          isVerified: false,
          authorAvatarSrc: '.cache/images/shared/b.webp',
          postedDateLabel: '1h',
          text: '😂😂😂',
          likes: 50,
          strippedVideoCount: 0,
        },
      ],
    });

    const script = await director.direct(accentedPost);
    const mainSeg = script.segments[0]!;
    expect(mainSeg.visualCues.some((c) => c.stickerCode === 'clown')).toBe(true);
    expect(mainSeg.audioCues.some((c) => c.sfxSlug === 'vine_boom')).toBe(true);

    const cmt1 = script.segments.find((s) => s.sourceCommentId === 'c_acc_1')!;
    expect(cmt1.visualCues.length).toBeGreaterThan(0);

    // Emoji-only comment must get safe non-emoji ttsText
    const cmtEmoji = script.segments.find((s) => s.sourceCommentId === 'c_acc_2')!;
    expect(cmtEmoji.ttsText).not.toContain('😂');
    expect(cmtEmoji.ttsText.length).toBeGreaterThan(0);
  });
});
