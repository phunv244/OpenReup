import { z } from 'zod';
import {
  CommentStateSchema,
  MediaStateSchema,
  TextLengthStateSchema,
  ThreadsPostUrlSchema,
  type CommentState,
  type MediaState,
  type TextLengthState,
} from './common.js';

export const META_MEDIA_TYPE_IMAGE = 1;
export const META_MEDIA_TYPE_VIDEO = 2;
export const META_MEDIA_TYPE_CAROUSEL = 8;
export const META_MEDIA_TYPE_TEXT_ONLY = 19;

export const MAX_CAROUSEL_IMAGES = 6;
export const MAX_STORED_REPLIES = 20;

export const ThreadsMetricsSchema = z.object({
  likes: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative().default(0),
  reposts: z.number().int().nonnegative().default(0),
  shares: z.number().int().nonnegative().default(0),
});
export type ThreadsMetrics = z.infer<typeof ThreadsMetricsSchema>;

/**
 * Strict No-Video Policy: every media item kept in normalized posts/comments
 * MUST be a static image (`kind: 'image'`). Video items are never permitted.
 */
export const NormalizedThreadsImageSchema = z.object({
  kind: z.literal('image').default('image'),
  src: z.string().min(1),
  originalUrl: z.string().url().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: z.number().positive(),
});
export type NormalizedThreadsImage = z.infer<typeof NormalizedThreadsImageSchema>;

export const RawThreadsMediaItemSchema = z.object({
  mediaType: z.number().int(),
  src: z.string().min(1).optional(),
  originalUrl: z.string().url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasVideoVersions: z.boolean().optional(),
  imageFailed: z.boolean().optional(),
});
export type RawThreadsMediaItem = z.infer<typeof RawThreadsMediaItemSchema>;

export const NormalizedThreadsCommentSchema = z.object({
  id: z.string().min(1),
  authorHandle: z.string().min(1),
  authorDisplayName: z.string().min(1).optional(),
  isVerified: z.boolean().default(false),
  authorAvatarSrc: z.string().min(1),
  postedDateLabel: z.string().min(1),
  text: z.string().min(1),
  likes: z.number().int().nonnegative(),
  image: NormalizedThreadsImageSchema.optional(),
  strippedVideoCount: z.number().int().nonnegative().default(0),
});
export type NormalizedThreadsComment = z.infer<typeof NormalizedThreadsCommentSchema>;

export const NormalizedThreadsPostSchema = z
  .object({
    id: z.string().min(1),
    shortcode: z.string().min(1),
    sourceUrl: ThreadsPostUrlSchema,
    authorHandle: z.string().min(1),
    authorDisplayName: z.string().min(1).optional(),
    isVerified: z.boolean().default(false),
    authorAvatarPath: z.string().min(1),
    postedDisplayDate: z.string().min(1),
    rawText: z.string(),
    images: z.array(NormalizedThreadsImageSchema).max(MAX_CAROUSEL_IMAGES),
    strippedVideoCount: z.number().int().nonnegative().default(0),
    metrics: ThreadsMetricsSchema,
    topReplies: z.array(NormalizedThreadsCommentSchema).max(MAX_STORED_REPLIES),
    textLengthState: TextLengthStateSchema,
    mediaState: MediaStateSchema,
    commentState: CommentStateSchema,
    expiresAt: z.number().int().positive(),
    createdAt: z.number().int().positive(),
  })
  .superRefine((post, ctx) => {
    const trimmedText = post.rawText.trim();
    if (trimmedText.length === 0 && post.images.length === 0 && post.strippedVideoCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rawText'],
        message: 'ERR_VIDEO_ONLY_POST: Post contains only video with no caption or images',
      });
    }
  });
export type NormalizedThreadsPost = z.infer<typeof NormalizedThreadsPostSchema>;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export function classifyTextLengthState(text: string): TextLengthState {
  const words = countWords(text);
  if (words < 30) return 'ST-LEN-01';
  if (words <= 100) return 'ST-LEN-02';
  if (words <= 300) return 'ST-LEN-03';
  if (words <= 500) return 'ST-LEN-04';
  return 'ST-LEN-05';
}

export function classifyCommentState(totalCommentCount: number): CommentState {
  if (totalCommentCount <= 0) return 'ST-COM-01';
  if (totalCommentCount <= 2) return 'ST-COM-02';
  if (totalCommentCount <= 50) return 'ST-COM-03';
  return 'ST-COM-04';
}

export interface SanitizedMediaResult {
  images: NormalizedThreadsImage[];
  strippedVideoCount: number;
  failedImageCount: number;
  mediaState: MediaState;
}

/**
 * Enforces the Strict No-Video Policy (`ARCHITECTURE.md` 3.2 & `STATE_MATRIX.md` ST-MED-01..06):
 * - Drops all video items (`mediaType === 2` or `hasVideoVersions === true`)
 * - Drops failed/corrupt images (`imageFailed === true`) with safe fallback
 * - Caps carousel images to `maxCarouselImages` (default 6)
 */
export function sanitizeMediaItems(
  rawItems: readonly RawThreadsMediaItem[],
  options?: { maxCarouselImages?: number },
): SanitizedMediaResult {
  const maxImages = Math.min(options?.maxCarouselImages ?? MAX_CAROUSEL_IMAGES, MAX_CAROUSEL_IMAGES);
  const images: NormalizedThreadsImage[] = [];
  let strippedVideoCount = 0;
  let failedImageCount = 0;

  for (const item of rawItems) {
    if (item.mediaType === META_MEDIA_TYPE_VIDEO || item.hasVideoVersions === true) {
      strippedVideoCount += 1;
      continue;
    }

    if (item.mediaType !== META_MEDIA_TYPE_IMAGE) {
      continue;
    }

    if (item.imageFailed === true || !item.src || !item.width || !item.height) {
      failedImageCount += 1;
      continue;
    }

    if (images.length < maxImages) {
      images.push({
        kind: 'image',
        src: item.src,
        originalUrl: item.originalUrl,
        width: item.width,
        height: item.height,
        aspectRatio: Number((item.width / item.height).toFixed(4)),
      });
    }
  }

  let mediaState: MediaState;
  if (images.length >= 2) {
    mediaState = 'ST-MED-04';
  } else if (images.length === 1) {
    const single = images[0]!;
    mediaState = single.aspectRatio < 0.9 ? 'ST-MED-03' : 'ST-MED-02';
  } else if (failedImageCount > 0) {
    mediaState = 'ST-MED-06';
  } else if (strippedVideoCount > 0) {
    mediaState = 'ST-MED-05';
  } else {
    mediaState = 'ST-MED-01';
  }

  return {
    images,
    strippedVideoCount,
    failedImageCount,
    mediaState,
  };
}

/**
 * Splits long Threads post text into card-safe pages per `ARCHITECTURE.md` 4.1 & `STATE_MATRIX.md`:
 * - <= 280 chars per page for text-only cards
 * - <= 160 chars per page when paired with images
 * - Hard cap at 3 pages for mega stories (`ST-LEN-05`)
 */
export function paginatePostText(
  text: string,
  options?: { hasImages?: boolean; maxPages?: number },
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return [];
  }

  const maxCharsPerPage = options?.hasImages ? 160 : 280;
  const maxPages = options?.maxPages ?? 3;

  if (normalized.length <= maxCharsPerPage) {
    return [normalized];
  }

  const pages: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0 && pages.length < maxPages) {
    if (remaining.length <= maxCharsPerPage) {
      pages.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxCharsPerPage);
    let splitAt = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
    );

    if (splitAt >= Math.floor(maxCharsPerPage * 0.4)) {
      splitAt += 1; // keep punctuation
    } else {
      const lastSpace = slice.lastIndexOf(' ');
      splitAt = lastSpace > 0 ? lastSpace : maxCharsPerPage;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    const nextRemaining = remaining.slice(splitAt).trim();

    if (pages.length === maxPages - 1 && nextRemaining.length > 0) {
      const truncated = chunk.endsWith('...') ? chunk : `${chunk}...`;
      pages.push(truncated);
      break;
    }

    pages.push(chunk);
    remaining = nextRemaining;
  }

  return pages;
}
