import { z } from 'zod';

export const CANVAS_WIDTH = 1080 as const;
export const CANVAS_HEIGHT = 1920 as const;

export const DESIGN_SYSTEM_DEFAULTS = {
  canvas: {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    aspectRatio: '9:16',
    defaultFps: 60 as const,
  },
  safeZones: {
    top: 140,
    bottom: 300,
    right: 120,
    left: 40,
  },
  card: {
    width: 960,
    minHeight: 360,
    maxHeight: 1040,
    borderRadius: 36,
    padding: 44,
    avatarSize: 84,
    actionIconSize: 40,
    mediaMaxHeight: 580,
  },
  springPhysics: {
    cardEnter: {
      mass: 0.8,
      damping: 14,
      stiffness: 120,
      overshootClamping: false,
    },
    cardExit: {
      mass: 0.6,
      damping: 16,
      stiffness: 160,
      overshootClamping: true,
    },
  },
  zIndex: {
    backgroundVideo: 0,
    scrimOverlay: 10,
    contentCard: 20,
    hookBanner: 30,
    overlayCues: 40,
    debugWatermark: 50,
  },
} as const;

export const TextLengthStateSchema = z.enum([
  'ST-LEN-01',
  'ST-LEN-02',
  'ST-LEN-03',
  'ST-LEN-04',
  'ST-LEN-05',
]);
export type TextLengthState = z.infer<typeof TextLengthStateSchema>;

export const MediaStateSchema = z.enum([
  'ST-MED-01',
  'ST-MED-02',
  'ST-MED-03',
  'ST-MED-04',
  'ST-MED-05',
  'ST-MED-06',
]);
export type MediaState = z.infer<typeof MediaStateSchema>;

export const CommentStateSchema = z.enum([
  'ST-COM-01',
  'ST-COM-02',
  'ST-COM-03',
  'ST-COM-04',
]);
export type CommentState = z.infer<typeof CommentStateSchema>;

export const UiComponentStateSchema = z.enum([
  'LOADING',
  'NORMAL',
  'PARTIAL',
  'ERROR',
]);
export type UiComponentState = z.infer<typeof UiComponentStateSchema>;

export const ErrorCodeSchema = z.enum([
  'ERR_INVALID_URL',
  'ERR_POST_NOT_FOUND',
  'ERR_PRIVATE_ACCOUNT',
  'ERR_RATE_LIMITED',
  'ERR_POLICY_VIOLATION',
  'ERR_SCRAPER_TIMEOUT',
  'ERR_TTS_SYNTHESIS_FAILED',
  'ERR_RENDER_FAILED',
  'ERR_VIDEO_ONLY_POST',
  'ERR_VALIDATION_FAILED',
  'ERR_NO_VIDEO_IN_POST',
  'ERR_VIDEO_TOO_LONG',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SfxSlugSchema = z.enum([
  'whoosh',
  'pop',
  'vine_boom',
  'laughter',
  'ding',
]);
export type SfxSlug = z.infer<typeof SfxSlugSchema>;

export const StickerCodeSchema = z.enum([
  'clown',
  'skull',
  'laugh_cry',
  'question',
  'fire',
]);
export type StickerCode = z.infer<typeof StickerCodeSchema>;

export const StickerPositionSchema = z.enum([
  'TOP_RIGHT',
  'BOTTOM_RIGHT',
  'CENTER_CARD',
]);
export type StickerPosition = z.infer<typeof StickerPositionSchema>;

export const StickerAnimationSchema = z.enum([
  'POP_BOUNCE',
  'SHAKE',
  'FLOAT_UP',
  'PULSE',
]);
export type StickerAnimation = z.infer<typeof StickerAnimationSchema>;

export const ThemeSchema = z.enum(['light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

export const FpsSchema = z.union([z.literal(30), z.literal(60)]);
export type Fps = z.infer<typeof FpsSchema>;

export const VIENEU_VOICE_IDS = [
  'Thiện Minh',
  'Thiền Tâm Đức',
  'Hải Đăng',
  'Adam bựa',
  'Quang Sơn',
  'Minh Đức',
  'Phạm Tuyên',
  'Thái Sơn',
  'Xuân Vĩnh',
  'Thanh Bình',
  'Minh Triết',
  'Đức Trí',
  'Adam',
  'Quốc Tuấn',
  'Ngọc Huyền',
  'Trúc Ly',
  'Quỳnh Anh',
  'Mai Anh',
  'Thùy Dung',
  'Ngọc Trân',
  'Ngọc Linh',
  'Đoan Trang',
  'Thục Đoan',
  'Mỹ Duyên',
  'Kim Thanh',
] as const;

export const EDGE_TTS_FALLBACK_VOICE_IDS = [
  'vi-VN-HoaiMyNeural',
  'vi-VN-NamMinhNeural',
] as const;

export const DEFAULT_VOICE_ID = 'Adam bựa' as const;

export const VoiceIdSchema = z.enum([
  ...VIENEU_VOICE_IDS,
  ...EDGE_TTS_FALLBACK_VOICE_IDS,
]);
export type VoiceId = z.infer<typeof VoiceIdSchema>;

export interface VoiceCatalogEntry {
  readonly id: VoiceId;
  readonly engine: 'vieneu' | 'edge-tts';
  readonly gender: 'male' | 'female';
  readonly region: 'Bắc' | 'Trung' | 'Nam' | 'Chung';
  readonly style: string;
}

export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
  { id: 'Thiện Minh', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'kể chuyện' },
  { id: 'Thiền Tâm Đức', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'kể chuyện' },
  { id: 'Hải Đăng', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Adam bựa', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Quang Sơn', engine: 'vieneu', gender: 'male', region: 'Trung', style: 'tự nhiên' },
  { id: 'Minh Đức', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'tin tức' },
  { id: 'Phạm Tuyên', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Thái Sơn', engine: 'vieneu', gender: 'male', region: 'Nam', style: 'kể chuyện' },
  { id: 'Xuân Vĩnh', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Thanh Bình', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'kể chuyện' },
  { id: 'Minh Triết', engine: 'vieneu', gender: 'male', region: 'Nam', style: 'tin tức' },
  { id: 'Đức Trí', engine: 'vieneu', gender: 'male', region: 'Nam', style: 'đọc truyện' },
  { id: 'Adam', engine: 'vieneu', gender: 'male', region: 'Nam', style: 'tự nhiên' },
  { id: 'Quốc Tuấn', engine: 'vieneu', gender: 'male', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Ngọc Huyền', engine: 'vieneu', gender: 'female', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Trúc Ly', engine: 'vieneu', gender: 'female', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Quỳnh Anh', engine: 'vieneu', gender: 'female', region: 'Bắc', style: 'đọc truyện' },
  { id: 'Mai Anh', engine: 'vieneu', gender: 'female', region: 'Bắc', style: 'tin tức' },
  { id: 'Thùy Dung', engine: 'vieneu', gender: 'female', region: 'Nam', style: 'tin tức' },
  { id: 'Ngọc Trân', engine: 'vieneu', gender: 'female', region: 'Trung', style: 'tự nhiên' },
  { id: 'Ngọc Linh', engine: 'vieneu', gender: 'female', region: 'Bắc', style: 'kể chuyện' },
  { id: 'Đoan Trang', engine: 'vieneu', gender: 'female', region: 'Bắc', style: 'tự nhiên' },
  { id: 'Thục Đoan', engine: 'vieneu', gender: 'female', region: 'Nam', style: 'kể chuyện' },
  { id: 'Mỹ Duyên', engine: 'vieneu', gender: 'female', region: 'Nam', style: 'đọc truyện' },
  { id: 'Kim Thanh', engine: 'vieneu', gender: 'female', region: 'Nam', style: 'đọc truyện' },
  { id: 'vi-VN-HoaiMyNeural', engine: 'edge-tts', gender: 'female', region: 'Chung', style: 'fallback tự nhiên' },
  { id: 'vi-VN-NamMinhNeural', engine: 'edge-tts', gender: 'male', region: 'Chung', style: 'fallback tự nhiên' },
] as const;

export const PageIndicatorSchema = z
  .object({
    current: z.number().int().positive(),
    total: z.number().int().positive(),
  })
  .refine((val) => val.current <= val.total, {
    message: 'pageIndicator.current must be less than or equal to pageIndicator.total',
  });
export type PageIndicator = z.infer<typeof PageIndicatorSchema>;

const ALLOWED_THREADS_HOSTS = new Set([
  'threads.net',
  'www.threads.net',
  'threads.com',
  'www.threads.com',
]);

const THREADS_USER_POST_PATH_REGEX = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)\/?$/;
const THREADS_SHORT_POST_PATH_REGEX = /^\/t\/([A-Za-z0-9_-]+)\/?$/;

export interface ParsedThreadsUrl {
  canonicalUrl: string;
  shortcode: string;
  authorHandle?: string;
}

export function parseThreadsUrl(rawUrl: string): ParsedThreadsUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_THREADS_HOSTS.has(host)) {
    return null;
  }

  const userMatch = THREADS_USER_POST_PATH_REGEX.exec(parsed.pathname);
  if (userMatch && userMatch[1] && userMatch[2]) {
    const authorHandle = userMatch[1];
    const shortcode = userMatch[2];
    return {
      canonicalUrl: `https://www.threads.net/@${authorHandle}/post/${shortcode}`,
      shortcode,
      authorHandle,
    };
  }

  const shortMatch = THREADS_SHORT_POST_PATH_REGEX.exec(parsed.pathname);
  if (shortMatch && shortMatch[1]) {
    const shortcode = shortMatch[1];
    return {
      canonicalUrl: `https://www.threads.net/t/${shortcode}`,
      shortcode,
    };
  }

  return null;
}

export const ThreadsPostUrlSchema = z
  .string()
  .trim()
  .refine((value) => parseThreadsUrl(value) !== null, {
    message:
      'ERR_INVALID_URL: URL must be a valid https://threads.net or https://threads.com post link',
  });

const ALLOWED_CDN_SUFFIXES = ['.cdninstagram.com', '.fbcdn.net'];

export function isAllowedMediaCdnUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_CDN_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}
