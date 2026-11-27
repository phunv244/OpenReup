import { z } from 'zod';
import {
  PageIndicatorSchema,
  SfxSlugSchema,
  StickerAnimationSchema,
  StickerCodeSchema,
  StickerPositionSchema,
} from './common.js';

export const AudioCueDraftSchema = z.object({
  cueId: z.string().min(1),
  sfxSlug: SfxSlugSchema,
  triggerWord: z.string().min(1),
  volumeDb: z.number().min(-30).max(0).optional(),
});
export type AudioCueDraft = z.infer<typeof AudioCueDraftSchema>;

export const VisualCueDraftSchema = z.object({
  cueId: z.string().min(1),
  stickerCode: StickerCodeSchema,
  triggerWord: z.string().min(1),
  position: StickerPositionSchema,
  animation: StickerAnimationSchema,
});
export type VisualCueDraft = z.infer<typeof VisualCueDraftSchema>;

export const SegmentKindSchema = z.enum(['MAIN_POST', 'COMMENT', 'CTA_OUTRO']);
export type SegmentKind = z.infer<typeof SegmentKindSchema>;

export const DirectorSegmentSchema = z.object({
  segmentId: z.string().min(1),
  kind: SegmentKindSchema,
  sourceCommentId: z.string().min(1).optional(),
  authorHandle: z.string().min(1),
  replyingToHandle: z.string().min(1).optional(),
  pageIndicator: PageIndicatorSchema.optional(),
  displayText: z.string().min(1),
  ttsText: z.string().min(1),
  imageIndexes: z.array(z.number().int().nonnegative()).default([]),
  audioCues: z.array(AudioCueDraftSchema).default([]),
  visualCues: z.array(VisualCueDraftSchema).default([]),
});
export type DirectorSegment = z.infer<typeof DirectorSegmentSchema>;

export const HookLinesSchema = z.union([
  z.tuple([z.string().min(1)]),
  z.tuple([z.string().min(1), z.string().min(1)]),
]);
export type HookLines = z.infer<typeof HookLinesSchema>;

/**
 * VideoThreads v1.2 AI Director Output Schema (No Scoring):
 * Virality/humor scoring is handled externally by a separate bot.
 * This contract covers hook copywriting, comment selection/ordering,
 * smart pagination, dual displayText/ttsText, and SFX/Sticker cues.
 */
export const AIDirectorOutputSchema = z.object({
  id: z.string().min(1),
  postId: z.string().min(1),
  modelName: z.string().min(1),
  hookLines: HookLinesSchema,
  selectedCommentIds: z.array(z.string().min(1)).max(5).default([]),
  segments: z.array(DirectorSegmentSchema).min(1),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  createdAt: z.number().int().positive(),
});
export type AIDirectorOutput = z.infer<typeof AIDirectorOutputSchema>;
