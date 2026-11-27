import { MAX_STORED_REPLIES } from '../contracts/index.js';
import type { ScraperErrorCode } from './errors.js';
import type {
  RawMetaImageCandidate,
  RawMetaPostNode,
  RawScrapePayload,
} from './types.js';

const SCRIPT_DATA_SJS_REGEX =
  /<script\b[^>]*type=["']application\/json["'][^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/gi;

const MAX_TRAVERSAL_DEPTH = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLikelyPostNode(value: unknown): value is RawMetaPostNode {
  if (!isRecord(value)) {
    return false;
  }
  const hasId = typeof value['pk'] === 'string' || typeof value['pk'] === 'number' || typeof value['id'] === 'string';
  const hasCode = typeof value['code'] === 'string';
  const hasUser = isRecord(value['user']) && typeof value['user']['username'] === 'string';
  return (hasId || hasCode) && hasUser;
}

function getPostIdentityKey(node: RawMetaPostNode): string {
  if (typeof node.code === 'string' && node.code.length > 0) {
    return `code:${node.code}`;
  }
  if (node.pk !== undefined && String(node.pk).length > 0) {
    return `pk:${String(node.pk)}`;
  }
  if (typeof node.id === 'string' && node.id.length > 0) {
    return `id:${node.id}`;
  }
  return `anon:${node.user?.username ?? 'unknown'}:${node.taken_at ?? 0}`;
}

function collectThreadPostsFromObject(
  root: unknown,
  collected: RawMetaPostNode[],
  seenObjects: WeakSet<object>,
  depth = 0,
): void {
  if (depth > MAX_TRAVERSAL_DEPTH || root === null || typeof root !== 'object') {
    return;
  }
  if (seenObjects.has(root)) {
    return;
  }
  seenObjects.add(root);

  if (Array.isArray(root)) {
    for (const item of root) {
      collectThreadPostsFromObject(item, collected, seenObjects, depth + 1);
    }
    return;
  }

  const record = root as Record<string, unknown>;

  // Meta Relay thread item shape: { post: { pk, code, user, caption, ... } }
  if (isLikelyPostNode(record['post'])) {
    collected.push(record['post']);
  } else if (isLikelyPostNode(record)) {
    collected.push(record);
  }

  for (const key of Object.keys(record)) {
    if (key === 'post' && isLikelyPostNode(record[key])) {
      continue;
    }
    const child = record[key];
    if (child !== null && typeof child === 'object') {
      collectThreadPostsFromObject(child, collected, seenObjects, depth + 1);
    }
  }
}

export function buildRawScrapePayload(
  posts: readonly RawMetaPostNode[],
  targetShortcode?: string,
): RawScrapePayload | null {
  if (posts.length === 0) {
    return null;
  }

  const uniqueByKey = new Map<string, RawMetaPostNode>();
  for (const post of posts) {
    const key = getPostIdentityKey(post);
    if (!uniqueByKey.has(key)) {
      uniqueByKey.set(key, post);
    }
  }

  const uniquePosts = Array.from(uniqueByKey.values());
  let rootPost: RawMetaPostNode | undefined;

  if (targetShortcode) {
    rootPost = uniquePosts.find((post) => post.code === targetShortcode);
  }
  if (!rootPost) {
    rootPost = uniquePosts[0];
  }
  if (!rootPost) {
    return null;
  }

  const rootKey = getPostIdentityKey(rootPost);
  const allReplies = uniquePosts.filter((post) => getPostIdentityKey(post) !== rootKey);

  // ST-COM-04: sort replies by likes desc and cap to top 20
  const sortedReplies = [...allReplies]
    .sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0))
    .slice(0, MAX_STORED_REPLIES);

  const reportedReplyCount = rootPost.text_post_app_info?.direct_reply_count ?? 0;
  const totalReplyCount = Math.max(reportedReplyCount, allReplies.length);

  return {
    rootPost,
    replies: sortedReplies,
    totalReplyCount,
  };
}

export function extractThreadFromGraphql(
  payload: unknown,
  targetShortcode?: string,
): RawScrapePayload | null {
  const posts: RawMetaPostNode[] = [];
  collectThreadPostsFromObject(payload, posts, new WeakSet<object>());
  return buildRawScrapePayload(posts, targetShortcode);
}

export function extractThreadFromHtml(
  html: string,
  targetShortcode?: string,
): RawScrapePayload | null {
  const posts: RawMetaPostNode[] = [];
  const seenObjects = new WeakSet<object>();

  SCRIPT_DATA_SJS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = SCRIPT_DATA_SJS_REGEX.exec(html);

  while (match !== null) {
    const rawJson = match[1]?.trim();
    if (rawJson && (rawJson.includes('thread_items') || rawJson.includes('"user"') || rawJson.includes('"caption"'))) {
      try {
        const parsed: unknown = JSON.parse(rawJson);
        collectThreadPostsFromObject(parsed, posts, seenObjects);
      } catch {
        // Ignore malformed script blocks
      }
    }
    match = SCRIPT_DATA_SJS_REGEX.exec(html);
  }

  return buildRawScrapePayload(posts, targetShortcode);
}

export function selectBestImageCandidate(
  candidates: readonly RawMetaImageCandidate[] | undefined | null,
  targetWidth = 1080,
): RawMetaImageCandidate | null {
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const valid = candidates.filter(
    (c) => typeof c.url === 'string' && c.url.trim().length > 0,
  );
  if (valid.length === 0) {
    return null;
  }

  let best = valid[0]!;
  let bestDistance = Math.abs((best.width ?? 0) - targetWidth);

  for (let i = 1; i < valid.length; i += 1) {
    const candidate = valid[i]!;
    const candWidth = candidate.width ?? 0;
    const bestWidth = best.width ?? 0;
    const distance = Math.abs(candWidth - targetWidth);

    // Prefer closest width to targetWidth; on tie prefer larger width (>= targetWidth)
    if (
      distance < bestDistance ||
      (distance === bestDistance && candWidth > bestWidth)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

export function detectBlockedUrlOrHtml(
  url: string,
  html?: string,
): Extract<
  ScraperErrorCode,
  'ERR_PRIVATE_ACCOUNT' | 'ERR_RATE_LIMITED' | 'ERR_POST_NOT_FOUND'
> | null {
  const lowerUrl = url.toLowerCase();

  if (
    lowerUrl.includes('/challenge') ||
    lowerUrl.includes('/checkpoint') ||
    lowerUrl.includes('captcha')
  ) {
    return 'ERR_RATE_LIMITED';
  }

  if (
    lowerUrl.includes('/login') ||
    lowerUrl.includes('/accounts/login')
  ) {
    return 'ERR_PRIVATE_ACCOUNT';
  }

  if (!html) {
    return null;
  }

  const lowerHtml = html.toLowerCase();

  if (
    lowerHtml.includes('checkpoint_required') ||
    lowerHtml.includes('please wait a few minutes before you try again') ||
    lowerHtml.includes('cf-turnstile') ||
    lowerHtml.includes('g-recaptcha') ||
    lowerHtml.includes('hcaptcha')
  ) {
    return 'ERR_RATE_LIMITED';
  }

  if (
    lowerHtml.includes('this account is private') ||
    lowerHtml.includes('tài khoản này ở chế độ riêng tư') ||
    lowerHtml.includes('log in to see this post')
  ) {
    return 'ERR_PRIVATE_ACCOUNT';
  }

  if (
    lowerHtml.includes('sorry, this page isn\'t available') ||
    lowerHtml.includes('this page isn&#039;t available') ||
    lowerHtml.includes('rất tiếc, trang này hiện không khả dụng')
  ) {
    return 'ERR_POST_NOT_FOUND';
  }

  return null;
}
