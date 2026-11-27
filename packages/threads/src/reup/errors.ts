export type ReupErrorCode =
  | 'ERR_VALIDATION_FAILED'
  | 'ERR_NO_VIDEO_IN_POST'
  | 'ERR_VIDEO_TOO_LONG'
  | 'ERR_REUP_INGEST_FAILED'
  | 'ERR_REUP_TRANSCRIBE_FAILED'
  | 'ERR_REUP_ADAPT_FAILED'
  | 'ERR_REUP_RENDER_FAILED';

export class ReupError extends Error {
  readonly code: ReupErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ReupErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ReupError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export function isReupError(error: unknown): error is ReupError {
  return error instanceof ReupError;
}
