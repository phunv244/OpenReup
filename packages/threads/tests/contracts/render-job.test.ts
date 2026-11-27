import { describe, expect, it } from 'vitest';
import {
  AnalyzeRequestSchema,
  ApiErrorResponseSchema,
  CreateJobRequestSchema,
  DEFAULT_VOICE_ID,
  JobSseEventSchema,
  RenderJobSchema,
} from '../../src/contracts/index.js';

describe('RenderJob & REST/SSE API Contracts', () => {
  it('validates RenderJobSchema with defaults (Adam bựa, 60fps, dark) and lifecycle fields', () => {
    const parsed = RenderJobSchema.parse({
      id: 'job_01',
      postId: 'post_01',
      scriptId: 'script_01',
      status: 'COMPLETED',
      outputVideoPath: '/var/lib/videothreads/out/job_01.mp4',
      videoDurationSec: 58.4,
      latencyBreakdownMs: {
        scrape: 1800,
        ai: 2200,
        tts: 7500,
        render: 18000,
        total: 29500,
      },
      errorCode: null,
      errorMessage: null,
      createdAt: 1764176400,
      completedAt: 1764176429,
    });

    expect(parsed.fps).toBe(60);
    expect(parsed.theme).toBe('dark');
    expect(parsed.voiceId).toBe(DEFAULT_VOICE_ID);
  });

  it('validates POST /api/v1/analyze and POST /api/v1/jobs requests', () => {
    expect(
      AnalyzeRequestSchema.safeParse({
        url: 'https://www.threads.net/@uyentich19/post/C8AbCdEf123',
      }).success,
    ).toBe(true);

    expect(
      CreateJobRequestSchema.safeParse({
        url: 'https://www.threads.net/@uyentich19/post/C8AbCdEf123',
        fps: 30,
        theme: 'light',
        voiceId: 'Trúc Ly',
      }).success,
    ).toBe(true);

    expect(CreateJobRequestSchema.safeParse({ scriptId: 'script_01' }).success).toBe(true);
    expect(CreateJobRequestSchema.safeParse({ fps: 60 }).success).toBe(false);
  });

  it('validates SSE progress events and STATE_MATRIX error responses', () => {
    expect(
      JobSseEventSchema.safeParse({
        jobId: 'job_01',
        status: 'DIRECTING',
        progress: 25,
        timestamp: 1764176415,
      }).success,
    ).toBe(true);

    expect(
      ApiErrorResponseSchema.safeParse({
        success: false,
        code: 'ERR_POLICY_VIOLATION',
        message: 'Nội dung bài viết vi phạm chính sách cộng đồng.',
      }).success,
    ).toBe(true);
  });
});
