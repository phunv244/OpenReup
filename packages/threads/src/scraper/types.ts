import type { NormalizedThreadsPost } from '../contracts/index.js';
import type { PostRepository } from '../db/index.js';
import type { DnsLookupFn } from './ssrf-guard.js';

export interface RawMetaImageCandidate {
  url: string;
  width?: number;
  height?: number;
}

export interface RawMetaVideoVersion {
  url?: string;
  type?: number;
  width?: number;
  height?: number;
}

export interface RawMetaCarouselItem {
  media_type?: number;
  image_versions2?: {
    candidates?: RawMetaImageCandidate[];
  };
  video_versions?: RawMetaVideoVersion[] | null;
  original_width?: number;
  original_height?: number;
}

export interface RawMetaUser {
  username?: string;
  full_name?: string | null;
  is_verified?: boolean;
  profile_pic_url?: string | null;
}

export interface RawMetaTextPostAppInfo {
  direct_reply_count?: number;
  repost_count?: number;
  quote_count?: number;
  reshare_count?: number;
  share_count?: number;
}

export interface RawMetaPostNode {
  id?: string;
  pk?: string | number;
  code?: string;
  user?: RawMetaUser;
  caption?: {
    text?: string | null;
  } | null;
  taken_at?: number;
  media_type?: number;
  image_versions2?: {
    candidates?: RawMetaImageCandidate[];
  } | null;
  video_versions?: RawMetaVideoVersion[] | null;
  carousel_media?: RawMetaCarouselItem[] | null;
  like_count?: number;
  text_post_app_info?: RawMetaTextPostAppInfo | null;
  original_width?: number;
  original_height?: number;
}

export interface RawScrapePayload {
  rootPost: RawMetaPostNode;
  replies: RawMetaPostNode[];
  totalReplyCount: number;
}

export type ScrapeTierSource = 'cache' | 'tier1_ssr' | 'tier2_playwright';

export interface ScrapeResult {
  post: NormalizedThreadsPost;
  source: ScrapeTierSource;
  durationMs: number;
  warnings: string[];
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ImageProcessorConfig {
  cacheDir: string;
  maxWidth?: number;
  webpQuality?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxBytes?: number;
  fetchFn?: FetchLike;
  verifyDns?: boolean;
  dnsLookupFn?: DnsLookupFn;
  allowLocalTestHosts?: boolean;
}

export interface ScraperServiceConfig {
  cacheDir?: string;
  postRepository?: PostRepository;
  cacheTtlSeconds?: number;
  timeoutMs?: number;
  minRepliesForTier1?: number;
  enableTier2Fallback?: boolean;
  defaultAvatarPath?: string;
  fetchFn?: FetchLike;
  verifyDns?: boolean;
  dnsLookupFn?: DnsLookupFn;
  allowLocalTestHosts?: boolean;
  chromiumExecutablePath?: string;
}

export interface ScrapeOptions {
  jobId?: string;
  bypassCache?: boolean;
  nowEpochSec?: number;
}
