import { z } from 'zod';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  FpsSchema,
  PageIndicatorSchema,
  StickerAnimationSchema,
  StickerCodeSchema,
  StickerPositionSchema,
  TextLengthStateSchema,
  ThemeSchema,
} from './common.js';
import { HookLinesSchema, SegmentKindSchema } from './ai-director.js';

export const TransitionInSchema = z.enum(['SPRING_POP', 'PAGE_FLIP']);
export type TransitionIn = z.infer<typeof TransitionInSchema>;

export const HookBannerStyleVariantSchema = z.enum(['white-pill', 'dark-pill']);
export type HookBannerStyleVariant = z.infer<typeof HookBannerStyleVariantSchema>;

export const WordTimingSchema = z
  .object({
    word: z.string().min(1),
    startLocalFrame: z.number().int().nonnegative(),
    endLocalFrame: z.number().int().nonnegative(),
  })
  .refine((val) => val.endLocalFrame >= val.startLocalFrame, {
    message: 'wordTiming.endLocalFrame must be >= startLocalFrame',
  });
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const CompositionCardImageSchema = z.object({
  src: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: z.number().positive(),
});
export type CompositionCardImage = z.infer<typeof CompositionCardImageSchema>;

export const CompositionCardMetricsSchema = z.object({
  likes: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative().optional(),
  reposts: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
});
export type CompositionCardMetrics = z.infer<typeof CompositionCardMetricsSchema>;

export const CompositionVisualCueSchema = z.object({
  cueId: z.string().min(1),
  triggerLocalFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  stickerCode: StickerCodeSchema,
  position: StickerPositionSchema,
  animation: StickerAnimationSchema,
});
export type CompositionVisualCue = z.infer<typeof CompositionVisualCueSchema>;

export const CompositionCardSchema = z
  .object({
    authorHandle: z.string().min(1),
    authorDisplayName: z.string().min(1).optional(),
    isVerified: z.boolean().optional(),
    authorAvatarSrc: z.string().min(1),
    postedDateLabel: z.string().min(1),
    replyingToHandle: z.string().min(1).optional(),
    pageIndicator: PageIndicatorSchema.optional(),
    textLengthState: TextLengthStateSchema,
    displayText: z.string().min(1),
    wordTimings: z.array(WordTimingSchema).optional(),
    images: z.array(CompositionCardImageSchema).max(6),
    activeImageIndex: z.number().int().nonnegative().optional(),
    metrics: CompositionCardMetricsSchema,
  })
  .superRefine((card, ctx) => {
    if (card.activeImageIndex !== undefined && card.activeImageIndex >= card.images.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activeImageIndex'],
        message: 'activeImageIndex must be within bounds of card.images',
      });
    }
  });
export type CompositionCard = z.infer<typeof CompositionCardSchema>;

export const CompositionSegmentSchema = z
  .object({
    segmentId: z.string().min(1),
    kind: SegmentKindSchema,
    startFrame: z.number().int().nonnegative(),
    durationInFrames: z.number().int().positive(),
    transitionIn: TransitionInSchema,
    card: CompositionCardSchema,
    visualCues: z.array(CompositionVisualCueSchema),
  })
  .superRefine((segment, ctx) => {
    for (let i = 0; i < segment.visualCues.length; i++) {
      const cue = segment.visualCues[i]!;
      if (cue.triggerLocalFrame >= segment.durationInFrames) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['visualCues', i, 'triggerLocalFrame'],
          message: 'visualCue.triggerLocalFrame must be less than segment.durationInFrames',
        });
      }
    }
  });
export type CompositionSegment = z.infer<typeof CompositionSegmentSchema>;

export const VideoCompositionPropsSchema = z
  .object({
    meta: z.object({
      jobId: z.string().min(1),
      width: z.literal(CANVAS_WIDTH),
      height: z.literal(CANVAS_HEIGHT),
      fps: FpsSchema,
      totalFrames: z.number().int().positive(),
      theme: ThemeSchema,
    }),
    background: z.object({
      videoSrc: z.string().min(1),
      startFromFrame: z.number().int().nonnegative(),
      dimOpacity: z.number().min(0).max(1),
    }),
    audio: z.object({
      masterAudioSrc: z.string().min(1),
    }),
    hookBanner: z.object({
      lines: HookLinesSchema,
      styleVariant: HookBannerStyleVariantSchema,
    }),
    segments: z.array(CompositionSegmentSchema).min(1),
  })
  .superRefine((props, ctx) => {
    let previousEndFrame = 0;

    for (let i = 0; i < props.segments.length; i++) {
      const segment = props.segments[i]!;
      const endFrame = segment.startFrame + segment.durationInFrames;

      if (endFrame > props.meta.totalFrames) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', i, 'durationInFrames'],
          message: `Segment "${segment.segmentId}" ends at frame ${endFrame}, exceeding meta.totalFrames (${props.meta.totalFrames})`,
        });
      }

      if (i > 0 && segment.startFrame < previousEndFrame) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', i, 'startFrame'],
          message: `Segment "${segment.segmentId}" overlaps previous segment (startFrame ${segment.startFrame} < ${previousEndFrame})`,
        });
      }

      previousEndFrame = endFrame;
    }
  });

export type VideoCompositionProps = z.infer<typeof VideoCompositionPropsSchema>;
