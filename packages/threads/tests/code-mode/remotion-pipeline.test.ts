import { describe, expect, it } from 'vitest';
import {
  buildVideoCompositionProps,
  openVideoPreview,
  renderPreviewStill,
  renderThreadsVideo,
  runThreadsVideoPipeline,
} from '../../src/code-mode/index.js';

describe('Code Mode Remotion & Pipeline SDK (T3.5 & T3.6)', () => {
  it('openVideoPreview returns consistent { command, studioUrl, port, description } contract and defaults to 3001', async () => {
    const def = await openVideoPreview({});
    expect(def.ok).toBe(true);
    if (def.ok) {
      expect(def.data.port).toBe(3001);
      expect(def.data.studioUrl).toBe('http://localhost:3001');
    }
    const res = await openVideoPreview({ port: 3100 });
    expect(res.ok).toBe(true);
    expect(res.success).toBe(true);
    if (res.ok) {
      expect(res.data.port).toBe(3100);
      expect(res.data.studioUrl).toBe('http://localhost:3100');
      expect(res.data.command).toContain('--port=3100');
      expect(res.data.description.length).toBeGreaterThan(0);
    }
  });

  it('renderPreviewStill accepts 1-object input and returns ERR_VALIDATION_FAILED on invalid props', async () => {
    const result = await renderPreviewStill({
      // @ts-expect-error intentionally invalid props
      props: { invalid: true },
      frame: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.success).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ERR_VALIDATION_FAILED');
    }
  });

  it('renderThreadsVideo accepts 1-object input and returns ERR_VALIDATION_FAILED on invalid props', async () => {
    const result = await renderThreadsVideo({
      // @ts-expect-error intentionally invalid props
      props: { invalid: true },
      codec: 'h264',
    });
    expect(result.ok).toBe(false);
    expect(result.success).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ERR_VALIDATION_FAILED');
    }
  });

  it('runThreadsVideoPipeline returns ERR_VALIDATION_FAILED when neither url nor scrapedPost is given', async () => {
    const result = await runThreadsVideoPipeline({});
    expect(result.ok).toBe(false);
    expect(result.success).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ERR_VALIDATION_FAILED');
      expect(result.error.message).toContain('Either url or scrapedPost must be provided');
    }
  });

  it('buildVideoCompositionProps returns ok: true when options are valid', async () => {
    const result = await buildVideoCompositionProps({
      jobId: 'cm_job_01',
      directorScript: {
        id: 'dir_01',
        postId: 'p01',
        modelName: 'test',
        hookLines: ['HOOK 1'],
        selectedCommentIds: [],
        segments: [
          {
            segmentId: 'seg_01',
            kind: 'MAIN_POST',
            authorHandle: 'test',
            displayText: 'Post text for testing',
            ttsText: 'Post text for testing',
            imageIndexes: [],
            audioCues: [],
            visualCues: [],
          },
        ],
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        createdAt: 1764176400,
      },
      synthesizedSegments: [
        {
          segmentId: 'seg_01',
          kind: 'MAIN_POST',
          wavPath: '/tmp/test.wav',
          durationMs: 3000,
          numSamples: 144000,
          sampleRate: 48000,
          channels: 1,
          trimmedLeadingMs: 0,
          wordTimings: [],
          backendUsed: 'vieneu_gpu',
        },
      ],
      masterAudioPath: '/tmp/master.wav',
      scrapedPost: {
        id: 'p01',
        shortcode: 'code1',
        sourceUrl: 'https://www.threads.net/@test/post/code1',
        authorHandle: 'test',
        isVerified: false,
        authorAvatarPath: '/tmp/avatar.webp',
        postedDisplayDate: '1h',
        rawText: 'Post text',
        images: [],
        strippedVideoCount: 0,
        metrics: { likes: 0, replies: 0, reposts: 0, shares: 0 },
        topReplies: [],
        textLengthState: 'ST-LEN-01',
        mediaState: 'ST-MED-01',
        commentState: 'ST-COM-01',
        expiresAt: 1764176400 + 86400,
        createdAt: 1764176400,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.success).toBe(true);
    if (result.ok) {
      expect(result.data.meta.width).toBe(1080);
      expect(result.data.meta.height).toBe(1920);
      expect(result.data.meta.jobId).toBe('cm_job_01');
    }
  });
});
