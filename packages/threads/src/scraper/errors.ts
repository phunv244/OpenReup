import type { ErrorCode } from '../contracts/index.js';

export type ScraperErrorCode = Extract<
  ErrorCode,
  | 'ERR_INVALID_URL'
  | 'ERR_POST_NOT_FOUND'
  | 'ERR_PRIVATE_ACCOUNT'
  | 'ERR_RATE_LIMITED'
  | 'ERR_SCRAPER_TIMEOUT'
  | 'ERR_VIDEO_ONLY_POST'
>;

export const DEFAULT_SCRAPER_ERROR_MESSAGES: Record<ScraperErrorCode, string> = {
  ERR_INVALID_URL:
    'Đường dẫn không hợp lệ. Vui lòng cung cấp link bài viết Threads chuẩn (dạng https://www.threads.net/@user/post/xyz).',
  ERR_POST_NOT_FOUND:
    'Bài viết không tồn tại hoặc đã bị tác giả gỡ bỏ trên Threads.',
  ERR_PRIVATE_ACCOUNT:
    'Bài viết thuộc tài khoản riêng tư (Private). Hệ thống chỉ hỗ trợ bài viết công khai.',
  ERR_RATE_LIMITED:
    'Hệ thống đang bị giới hạn truy cập từ máy chủ nguồn. Vui lòng thử lại sau ít phút hoặc sử dụng kênh proxy dự phòng.',
  ERR_SCRAPER_TIMEOUT:
    'Quá thời gian chờ phản hồi từ Threads (10s). Vui lòng thử lại sau.',
  ERR_VIDEO_ONLY_POST:
    'Bài viết chỉ chứa video và không có nội dung văn bản hoặc hình ảnh tĩnh để tạo video.',
};

export interface ScraperErrorOptions {
  message?: string;
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface ScraperApiErrorPayload {
  success: false;
  code: ScraperErrorCode;
  message: string;
}

export class ScraperError extends Error {
  readonly code: ScraperErrorCode;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ScraperErrorCode, options?: ScraperErrorOptions) {
    super(options?.message ?? DEFAULT_SCRAPER_ERROR_MESSAGES[code], {
      cause: options?.cause,
    });
    this.name = 'ScraperError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
    this.retryable = options?.retryable ?? code === 'ERR_SCRAPER_TIMEOUT';
    this.details = options?.details;
  }

  toApiError(): ScraperApiErrorPayload {
    return {
      success: false,
      code: this.code,
      message: this.message,
    };
  }
}

export function isScraperError(error: unknown): error is ScraperError {
  return error instanceof ScraperError;
}

export function mapHttpStatusToScraperError(
  status: number,
  url?: string,
): ScraperError | null {
  if (status === 404 || status === 410) {
    return new ScraperError('ERR_POST_NOT_FOUND', {
      httpStatus: status,
      retryable: false,
      details: url ? { url } : undefined,
    });
  }

  if (status === 401 || status === 403) {
    return new ScraperError('ERR_PRIVATE_ACCOUNT', {
      httpStatus: status,
      retryable: false,
      details: url ? { url } : undefined,
    });
  }

  if (status === 429) {
    return new ScraperError('ERR_RATE_LIMITED', {
      httpStatus: status,
      retryable: false,
      details: url ? { url } : undefined,
    });
  }

  return null;
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof ScraperError && error.code === 'ERR_SCRAPER_TIMEOUT') {
    return true;
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return (
      name === 'aborterror' ||
      name === 'timeouterror' ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('aborted')
    );
  }
  return false;
}
