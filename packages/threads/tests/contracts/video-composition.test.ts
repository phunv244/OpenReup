import { describe, expect, it } from 'vitest';
import {
  DESIGN_SYSTEM_DEFAULTS,
  VideoCompositionPropsSchema,
  type VideoCompositionProps,
} from '../../src/contracts/index.js';

function makeValidCompositionProps(
  overrides: Partial<VideoCompositionProps> = {},
): VideoCompositionProps {
  return {
    meta: {
      jobId: 'job_01',
      width: 1080,
      height: 1920,
      fps: 60,
      totalFrames: 600,
      theme: 'dark',
    },
    background: {
      videoSrc: 'gameplay/minecraft_parkour_01.mp4',
      startFromFrame: 120,
      dimOpacity: 0.4,
    },
    audio: {
      masterAudioSrc: '/tmp/videothreads/job_01/master_audio.wav',
    },
    hookBanner: {
      lines: ['Lương 9tr2 bị bắt OT vì đam mê 🤡', 'Cái kết khiến ai cũng bất ngờ!'],
      styleVariant: 'white-pill',
    },
    segments: [
      {
        segmentId: 'post_p1',
        kind: 'MAIN_POST',
        startFrame: 0,
        durationInFrames: 240,
        transitionIn: 'SPRING_POP',
        card: {
          authorHandle: 'uyentich19',
          authorDisplayName: 'Uyen Tich',
          isVerified: false,
          authorAvatarSrc: '/tmp/videothreads/job_01/images/avatar.webp',
          postedDateLabel: '11/02',
          pageIndicator: { current: 1, total: 2 },
          textLengthState: 'ST-LEN-04',
          displayText: 'Trang 1 nội dung bài viết rất dài...',
          wordTimings: [
            { word: 'Trang', startLocalFrame: 10, endLocalFrame: 22 },
            { word: 'một', startLocalFrame: 23, endLocalFrame: 35 },
          ],
          images: [
            {
              src: '/tmp/videothreads/job_01/images/img_0.webp',
              width: 1080,
              height: 1080,
              aspectRatio: 1,
            },
            {
              src: '/tmp/videothreads/job_01/images/img_1.webp',
              width: 1080,
              height: 1350,
              aspectRatio: 0.8,
            },
          ],
          activeImageIndex: 0,
          metrics: { likes: 1240, replies: 85, reposts: 42, shares: 19 },
        },
        visualCues: [
          {
            cueId: 'vc_1',
            triggerLocalFrame: 60,
            durationInFrames: 60,
            stickerCode: 'clown',
            position: 'TOP_RIGHT',
            animation: 'POP_BOUNCE',
          },
        ],
      },
      {
        segmentId: 'post_p2',
        kind: 'MAIN_POST',
        startFrame: 240,
        durationInFrames: 180,
        transitionIn: 'PAGE_FLIP',
        card: {
          authorHandle: 'uyentich19',
          authorAvatarSrc: '/tmp/videothreads/job_01/images/avatar.webp',
          postedDateLabel: '11/02',
          pageIndicator: { current: 2, total: 2 },
          textLengthState: 'ST-LEN-04',
          displayText: 'Trang 2 nội dung tiếp theo...',
          images: [],
          metrics: { likes: 1240, replies: 85 },
        },
        visualCues: [],
      },
      {
        segmentId: 'cta_outro',
        kind: 'CTA_OUTRO',
        startFrame: 420,
        durationInFrames: 180,
        transitionIn: 'SPRING_POP',
        card: {
          authorHandle: 'videothreads',
          authorAvatarSrc: '/tmp/videothreads/job_01/images/cta.webp',
          postedDateLabel: 'now',
          textLengthState: 'ST-LEN-01',
          displayText: 'Còn bạn, bạn nghĩ sao về tình huống này? Hãy để lại bình luận phía dưới! 👇',
          images: [],
          metrics: { likes: 0 },
        },
        visualCues: [],
      },
    ],
    ...overrides,
  };
}

describe('VideoCompositionProps Contract (1080x1920 Full HD)', () => {
  it('matches DESIGN_TOKENS.json core constants', () => {
    expect(DESIGN_SYSTEM_DEFAULTS.canvas.width).toBe(1080);
    expect(DESIGN_SYSTEM_DEFAULTS.canvas.height).toBe(1920);
    expect(DESIGN_SYSTEM_DEFAULTS.safeZones).toEqual({
      top: 140,
      bottom: 300,
      right: 120,
      left: 40,
    });
    expect(DESIGN_SYSTEM_DEFAULTS.springPhysics.cardEnter).toEqual({
      mass: 0.8,
      damping: 14,
      stiffness: 120,
      overshootClamping: false,
    });
  });

  it('validates a complete 1080x1920 multi-page + carousel + CTA composition', () => {
    const parsed = VideoCompositionPropsSchema.safeParse(makeValidCompositionProps());
    expect(parsed.success).toBe(true);
  });

  it('rejects non-1080x1920 resolutions', () => {
    const bad = makeValidCompositionProps();
    const parsed = VideoCompositionPropsSchema.safeParse({
      ...bad,
      meta: { ...bad.meta, width: 576, height: 1024 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects overlapping segments or segments exceeding totalFrames', () => {
    const base = makeValidCompositionProps();
    const overlapping = VideoCompositionPropsSchema.safeParse({
      ...base,
      segments: [
        base.segments[0]!,
        { ...base.segments[1]!, startFrame: 200 }, // overlaps 0..240
      ],
    });
    expect(overlapping.success).toBe(false);

    const overflow = VideoCompositionPropsSchema.safeParse({
      ...base,
      meta: { ...base.meta, totalFrames: 500 },
    });
    expect(overflow.success).toBe(false);
  });

  it('rejects invalid pageIndicator, out-of-bounds activeImageIndex, and out-of-bounds visualCue', () => {
    const base = makeValidCompositionProps();
    const seg0 = base.segments[0]!;

    const badPage = VideoCompositionPropsSchema.safeParse({
      ...base,
      segments: [{ ...seg0, card: { ...seg0.card, pageIndicator: { current: 3, total: 2 } } }],
    });
    expect(badPage.success).toBe(false);

    const badImageIdx = VideoCompositionPropsSchema.safeParse({
      ...base,
      segments: [{ ...seg0, card: { ...seg0.card, activeImageIndex: 5 } }],
    });
    expect(badImageIdx.success).toBe(false);

    const badCue = VideoCompositionPropsSchema.safeParse({
      ...base,
      segments: [
        {
          ...seg0,
          visualCues: [{ ...seg0.visualCues[0]!, triggerLocalFrame: 240 }],
        },
      ],
    });
    expect(badCue.success).toBe(false);
  });
});
