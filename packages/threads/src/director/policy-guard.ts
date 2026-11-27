import type { ErrorCode } from '../contracts/index.js';

export type DirectorErrorCode = Extract<ErrorCode, 'ERR_POLICY_VIOLATION'>;

export class DirectorError extends Error {
  readonly code: DirectorErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DirectorErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DirectorError';
    this.code = code;
    this.details = details;
  }
}

const POLICY_VIOLATION_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: 'explicit_nsfw',
    pattern: /(?<![\p{L}\p{N}_])(?:khiêu dâm|ấu dâm|clip sex|phim sex|porn|xxx)(?![\p{L}\p{N}_])/iu,
  },
  {
    label: 'severe_violence',
    pattern: /(?<![\p{L}\p{N}_])(?:giết người hàng loạt|tự tử đi|đánh bom khủng bố)(?![\p{L}\p{N}_])/iu,
  },
  {
    label: 'hate_speech',
    pattern: /(?<![\p{L}\p{N}_])(?:diệt chủng|kích động bạo lực)(?![\p{L}\p{N}_])/iu,
  },
];

/**
 * Content Moderation Gate (`STATE_MATRIX.md` ST-ERR-06):
 * Blocks severe 18+, violence, or hate-speech content before TTS synthesis.
 */
export function assertContentPolicySafe(text: string): void {
  for (const rule of POLICY_VIOLATION_PATTERNS) {
    if (rule.pattern.test(text)) {
      throw new DirectorError(
        'ERR_POLICY_VIOLATION',
        'Nội dung bài viết chứa từ ngữ vi phạm chính sách cộng đồng (18+, thù địch, bạo lực).',
        { matchedRule: rule.label },
      );
    }
  }
}
