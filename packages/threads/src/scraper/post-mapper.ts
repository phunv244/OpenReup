import { randomUUID } from 'node:crypto';
import {
  MAX_CAROUSEL_IMAGES,
  MAX_STORED_REPLIES,
  META_MEDIA_TYPE_CAROUSEL,
  META_MEDIA_TYPE_IMAGE,
  META_MEDIA_TYPE_VIDEO,
  NormalizedThreadsPostSchema,
  classifyCommentState,
  classifyTextLengthState,
  sanitizeMediaItems,
  type NormalizedThreadsComment,
  type NormalizedThreadsImage,
  type NormalizedThreadsPost,
  type RawThreadsMediaItem,
} from '../contracts/index.js';
import { ScraperError } from './errors.js';
import type { ImageProcessor, ProcessedImageResult } from './image-processor.js';
import { selectBestImageCandidate } from './relay-parser.js';
import type { RawMetaPostNode, RawScrapePayload } from './types.js';

export const DEFAULT_POST_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
export const DEFAULT_AVATAR_PLACEHOLDER = 'assets/default-avatar.webp';
export const MAX_IMAGE_DOWNLOAD_CONCURRENCY = 5;
const AVATAR_MAX_WIDTH = 256;

export interface MapRawPostOptions {
  canonicalUrl: string;
  shortcode: string;
  imageProcessor: ImageProcessor;
  jobId?: string;
  cacheTtlSeconds?: number;
  nowEpochSec?: number;
  defaultAvatarPath?: string;
  imageConcurrency?: number;
}

export interface MappedPostOutput {
  post: NormalizedThreadsPost;
  warnings: string[];
}

interface ExtractedMediaDescriptor {
  kind: 'video' | 'image';
  mediaType: number;
  url?: string;
  width?: number;
  height?: number;
  hasVideoVersions: boolean;
}

/**
 * Bounded concurrency worker pool. Enforces at most `limit` in-flight async tasks
 * to protect host RAM (libvips/sharp) and prevent Meta CDN rate-limiting.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current]!;
      results[current] = await worker(item, current);
    }
  }

  const workers = Array.from({ length: boundedLimit }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function hasVideoStream(
  mediaType: number | undefined,
  videoVersions: RawMetaPostNode['video_versions'],
): boolean {
  if (mediaType === META_MEDIA_TYPE_VIDEO) {
    return true;
  }
  return Array.isArray(videoVersions) && videoVersions.length > 0;
}

/**
 * Extracts media descriptors from a raw Meta Threads post or comment node,
 * tagging every video item (`media_type === 2` or non-empty `video_versions`)
 * so the Strict No-Video Policy drops 100% of video streams without ever downloading them.
 */
export function extractRawMediaDescriptors(
  node: RawMetaPostNode,
): ExtractedMediaDescriptor[] {
  const descriptors: ExtractedMediaDescriptor[] = [];

  if (
    node.media_type === META_MEDIA_TYPE_CAROUSEL &&
    Array.isArray(node.carousel_media) &&
    node.carousel_media.length > 0
  ) {
    for (const child of node.carousel_media) {
      if (hasVideoStream(child.media_type, child.video_versions)) {
        descriptors.push({
          kind: 'video',
          mediaType: META_MEDIA_TYPE_VIDEO,
          hasVideoVersions: true,
        });
        continue;
      }

      const best = selectBestImageCandidate(child.image_versions2?.candidates);
      if (best) {
        descriptors.push({
          kind: 'image',
          mediaType: META_MEDIA_TYPE_IMAGE,
          url: best.url,
          width: best.width ?? child.original_width,
          height: best.height ?? child.original_height,
          hasVideoVersions: false,
        });
      }
    }
    return descriptors;
  }

  if (hasVideoStream(node.media_type, node.video_versions)) {
    descriptors.push({
      kind: 'video',
      mediaType: META_MEDIA_TYPE_VIDEO,
      hasVideoVersions: true,
    });
    return descriptors;
  }

  if (node.media_type === META_MEDIA_TYPE_IMAGE || node.image_versions2?.candidates?.length) {
    const best = selectBestImageCandidate(node.image_versions2?.candidates);
    if (best) {
      descriptors.push({
        kind: 'image',
        mediaType: META_MEDIA_TYPE_IMAGE,
        url: best.url,
        width: best.width ?? node.original_width,
        height: best.height ?? node.original_height,
        hasVideoVersions: false,
      });
    }
  }

  return descriptors;
}

export function formatPostedDateLabel(
  takenAtEpochSec: number | undefined,
  nowEpochSec: number,
): string {
  if (!takenAtEpochSec || !Number.isFinite(takenAtEpochSec) || takenAtEpochSec <= 0) {
    return 'Vừa xong';
  }

  const diffSec = Math.max(0, nowEpochSec - takenAtEpochSec);
  if (diffSec < 60) {
    return 'Vừa xong';
  }
  if (diffSec < 3600) {
    return `${Math.floor(diffSec / 60)}m`;
  }
  if (diffSec < 86400) {
    return `${Math.floor(diffSec / 3600)}h`;
  }

  const date = new Date(takenAtEpochSec * 1000);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

interface ImageDownloadTask {
  key: string;
  url: string;
  maxWidth?: number;
}

interface PreparedReply {
  node: RawMetaPostNode;
  text: string;
  strippedVideoCount: number;
  avatarKey?: string;
  imageKey?: string;
}

export async function mapRawThreadToNormalizedPost(
  payload: RawScrapePayload,
  options: MapRawPostOptions,
): Promise<MappedPostOutput> {
  const warnings: string[] = [];
  const nowEpochSec = options.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options.cacheTtlSeconds ?? DEFAULT_POST_CACHE_TTL_SECONDS;
  const defaultAvatarPath = options.defaultAvatarPath ?? DEFAULT_AVATAR_PLACEHOLDER;
  const concurrency = Math.min(
    Math.max(1, options.imageConcurrency ?? MAX_IMAGE_DOWNLOAD_CONCURRENCY),
    MAX_IMAGE_DOWNLOAD_CONCURRENCY,
  );

  const root = payload.rootPost;
  const rawText = (root.caption?.text ?? '').trim();
  const descriptors = extractRawMediaDescriptors(root);

  // Separate video descriptors (dropped immediately without downloading) and image descriptors (capped at 6)
  const rawMediaItems: RawThreadsMediaItem[] = [];
  const downloadTasks: ImageDownloadTask[] = [];
  const postImageTaskKeys: Array<{ descriptorIndex: number; taskKey: string }> = [];

  for (const desc of descriptors) {
    if (desc.kind === 'video') {
      rawMediaItems.push({
        mediaType: META_MEDIA_TYPE_VIDEO,
        hasVideoVersions: true,
      });
      continue;
    }

    if (postImageTaskKeys.length < MAX_CAROUSEL_IMAGES && desc.url) {
      const idx = rawMediaItems.length;
      const taskKey = `post_img_${idx}`;
      rawMediaItems.push({
        mediaType: META_MEDIA_TYPE_IMAGE,
        originalUrl: desc.url,
        width: desc.width,
        height: desc.height,
        hasVideoVersions: false,
      });
      postImageTaskKeys.push({ descriptorIndex: idx, taskKey });
      downloadTasks.push({ key: taskKey, url: desc.url });
    }
  }

  // Early check: if post has NO text and NO candidate images and >=1 stripped video -> ERR_VIDEO_ONLY_POST
  if (
    rawText.length === 0 &&
    postImageTaskKeys.length === 0 &&
    rawMediaItems.some((m) => m.mediaType === META_MEDIA_TYPE_VIDEO)
  ) {
    throw new ScraperError('ERR_VIDEO_ONLY_POST', {
      details: {
        shortcode: options.shortcode,
        strippedVideoCount: rawMediaItems.filter((m) => m.mediaType === META_MEDIA_TYPE_VIDEO)
          .length,
      },
    });
  }

  // Queue root avatar
  const rootAvatarUrl = root.user?.profile_pic_url?.trim();
  const rootAvatarKey = rootAvatarUrl ? 'root_avatar' : undefined;
  if (rootAvatarUrl && rootAvatarKey) {
    downloadTasks.push({ key: rootAvatarKey, url: rootAvatarUrl, maxWidth: AVATAR_MAX_WIDTH });
  }

  // Prepare replies and queue their avatars & static images (dropping comment videos)
  const preparedReplies: PreparedReply[] = [];
  const rawReplies = payload.replies.slice(0, MAX_STORED_REPLIES);

  for (let i = 0; i < rawReplies.length; i += 1) {
    const replyNode = rawReplies[i]!;
    const text = (replyNode.caption?.text ?? '').trim();
    if (text.length === 0) {
      continue;
    }

    const replyDescriptors = extractRawMediaDescriptors(replyNode);
    let strippedVideoCount = 0;
    let firstImageUrl: string | undefined;

    for (const desc of replyDescriptors) {
      if (desc.kind === 'video') {
        strippedVideoCount += 1;
      } else if (!firstImageUrl && desc.url) {
        firstImageUrl = desc.url;
      }
    }

    const avatarUrl = replyNode.user?.profile_pic_url?.trim();
    const avatarKey = avatarUrl ? `reply_${i}_avatar` : undefined;
    if (avatarUrl && avatarKey) {
      downloadTasks.push({ key: avatarKey, url: avatarUrl, maxWidth: AVATAR_MAX_WIDTH });
    }

    const imageKey = firstImageUrl ? `reply_${i}_img` : undefined;
    if (firstImageUrl && imageKey) {
      downloadTasks.push({ key: imageKey, url: firstImageUrl });
    }

    preparedReplies.push({
      node: replyNode,
      text,
      strippedVideoCount,
      avatarKey,
      imageKey,
    });
  }

  // Execute all image & avatar downloads under strict bounded concurrency (<= 5)
  // using the shared content-hash NVMe cache (`images/shared/{sha256}.webp`)
  const completedTasks = await runWithConcurrency(downloadTasks, concurrency, async (task) => {
    const result = await options.imageProcessor.processImage(task.url, {
      maxWidth: task.maxWidth,
    });
    return { key: task.key, result };
  });

  const resultsByKey = new Map<string, ProcessedImageResult>();
  for (const item of completedTasks) {
    resultsByKey.set(item.key, item.result);
  }

  // Resolve root avatar
  let authorAvatarPath = defaultAvatarPath;
  if (rootAvatarKey) {
    const res = resultsByKey.get(rootAvatarKey);
    if (res?.ok) {
      authorAvatarPath = res.localPath;
    } else if (res) {
      warnings.push(`Avatar fallback applied (${res.reason})`);
    }
  }

  // Resolve post images
  for (const { descriptorIndex, taskKey } of postImageTaskKeys) {
    const target = rawMediaItems[descriptorIndex];
    const result = resultsByKey.get(taskKey);
    if (!target || !result) {
      continue;
    }
    if (result.ok) {
      target.src = result.localPath;
      target.originalUrl = result.originalUrl;
      target.width = result.width;
      target.height = result.height;
      target.imageFailed = false;
    } else {
      target.imageFailed = true;
      warnings.push(`Post image failed (${result.reason})`);
    }
  }

  const sanitizedMedia = sanitizeMediaItems(rawMediaItems, {
    maxCarouselImages: MAX_CAROUSEL_IMAGES,
  });

  // Re-verify ERR_VIDEO_ONLY_POST after image download/sanitization
  if (
    rawText.length === 0 &&
    sanitizedMedia.images.length === 0 &&
    sanitizedMedia.strippedVideoCount > 0
  ) {
    throw new ScraperError('ERR_VIDEO_ONLY_POST', {
      details: {
        shortcode: options.shortcode,
        strippedVideoCount: sanitizedMedia.strippedVideoCount,
      },
    });
  }

  // Map replies
  const topReplies: NormalizedThreadsComment[] = preparedReplies.map((prep) => {
    let replyAvatar = defaultAvatarPath;
    if (prep.avatarKey) {
      const avRes = resultsByKey.get(prep.avatarKey);
      if (avRes?.ok) {
        replyAvatar = avRes.localPath;
      } else if (avRes) {
        warnings.push(`Avatar fallback applied (${avRes.reason})`);
      }
    }

    let normalizedImage: NormalizedThreadsImage | undefined;
    if (prep.imageKey) {
      const imgRes = resultsByKey.get(prep.imageKey);
      if (imgRes?.ok) {
        normalizedImage = {
          kind: 'image',
          src: imgRes.localPath,
          originalUrl: imgRes.originalUrl,
          width: imgRes.width,
          height: imgRes.height,
          aspectRatio: imgRes.aspectRatio,
        };
      } else if (imgRes) {
        warnings.push(`Comment image dropped (${imgRes.reason})`);
      }
    }

    const node = prep.node;
    const commentId =
      (typeof node.id === 'string' && node.id.length > 0 ? node.id : undefined) ??
      (node.pk !== undefined ? String(node.pk) : undefined) ??
      node.code ??
      randomUUID();

    return {
      id: commentId,
      authorHandle: node.user?.username?.trim() || 'threads_user',
      authorDisplayName: node.user?.full_name?.trim() || undefined,
      isVerified: Boolean(node.user?.is_verified),
      authorAvatarSrc: replyAvatar,
      postedDateLabel: formatPostedDateLabel(node.taken_at, nowEpochSec),
      text: prep.text,
      likes: Math.max(0, Math.floor(node.like_count ?? 0)),
      image: normalizedImage,
      strippedVideoCount: prep.strippedVideoCount,
    };
  });

  const postId =
    (typeof root.id === 'string' && root.id.length > 0 ? root.id : undefined) ??
    (root.pk !== undefined ? String(root.pk) : undefined) ??
    randomUUID();

  const authorHandle = root.user?.username?.trim() || 'threads_user';
  const canonicalSourceUrl = options.canonicalUrl.includes('/@')
    ? options.canonicalUrl
    : `https://www.threads.net/@${authorHandle}/post/${options.shortcode}`;

  const textPostInfo = root.text_post_app_info;
  const totalReplyCount = Math.max(
    payload.totalReplyCount,
    textPostInfo?.direct_reply_count ?? 0,
    topReplies.length,
  );

  const normalized = NormalizedThreadsPostSchema.parse({
    id: postId,
    shortcode: root.code?.trim() || options.shortcode,
    sourceUrl: canonicalSourceUrl,
    authorHandle,
    authorDisplayName: root.user?.full_name?.trim() || undefined,
    isVerified: Boolean(root.user?.is_verified),
    authorAvatarPath,
    postedDisplayDate: formatPostedDateLabel(root.taken_at, nowEpochSec),
    rawText,
    images: sanitizedMedia.images,
    strippedVideoCount: sanitizedMedia.strippedVideoCount,
    metrics: {
      likes: Math.max(0, Math.floor(root.like_count ?? 0)),
      replies: Math.max(0, Math.floor(totalReplyCount)),
      reposts: Math.max(
        0,
        Math.floor((textPostInfo?.repost_count ?? 0) + (textPostInfo?.quote_count ?? 0)),
      ),
      shares: Math.max(
        0,
        Math.floor(textPostInfo?.share_count ?? textPostInfo?.reshare_count ?? 0),
      ),
    },
    topReplies,
    textLengthState: classifyTextLengthState(rawText),
    mediaState: sanitizedMedia.mediaState,
    commentState: classifyCommentState(totalReplyCount),
    expiresAt: nowEpochSec + ttlSeconds,
    createdAt: nowEpochSec,
  });

  return {
    post: normalized,
    warnings,
  };
}
