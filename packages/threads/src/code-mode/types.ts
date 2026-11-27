import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AudioError } from '../audio/index.js';
import { DirectorError } from '../director/index.js';
import { isReupError } from '../reup/errors.js';
import { isScraperError } from '../scraper/index.js';

export interface CodeModeMeta {
  traceId: string;
  durationMs: number;
  warnings: string[];
}

export interface CodeModeErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export type CodeModeResult<T> =
  | {
      ok: true;
      success: true;
      data: T;
      meta: CodeModeMeta;
    }
  | {
      ok: false;
      success: false;
      error: CodeModeErrorPayload;
      meta: CodeModeMeta;
    };

export function toCodeModeError(error: unknown): CodeModeErrorPayload {
  if (isScraperError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }

  if (error instanceof DirectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      details: error.details,
    };
  }

  if (error instanceof AudioError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }

  if (isReupError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      code: 'ERR_VALIDATION_FAILED',
      message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      retryable: false,
      details: error.issues,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'ERR_INTERNAL',
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: 'ERR_INTERNAL',
    message: String(error),
    retryable: false,
  };
}

export async function runCodeMode<T>(
  fn: (warnings: string[]) => Promise<T> | T,
): Promise<CodeModeResult<T>> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const warnings: string[] = [];

  try {
    const data = await fn(warnings);
    return {
      ok: true,
      success: true,
      data,
      meta: {
        traceId,
        durationMs: Date.now() - startedAt,
        warnings,
      },
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: toCodeModeError(error),
      meta: {
        traceId,
        durationMs: Date.now() - startedAt,
        warnings,
      },
    };
  }
}
