import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRemotionPublicDir } from '../../src/paths.js';
import { buildVideoCompositionProps } from '../../src/remotion/builder.js';
import { calculateThreadsVideoMetadata } from '../../src/remotion/Root.js';
import {
  computeDisplayTextActiveTokenIndex,
  tokenizeDisplayText,
} from '../../src/remotion/components/ThreadsCard.js';
import { createSampleCompositionProps } from '../../src/remotion/sample-props.js';
import { VideoCompositionPropsSchema } from '../../src/contracts/video-composition.js';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  SAFE_ZONES,
  SPRING_PHYSICS,
} from '../../src/remotion/constants.js';
import type { AIDirectorOutput } from '../../src/contracts/ai-director.js';
import type { NormalizedThreadsPost } from '../../src/contracts/threads-post.js';
import type { SynthesizedSegmentAudio } from '../../src/audio/types.js';

describe('Remotion Constants & Design Tokens (T3.5)', () => {
  it('satisfies 1080x1920 vertical video spec', () => {
    expect(CANVAS_WIDTH).toBe(1080);
    expect(CANVAS_HEIGHT).toBe(1920);
  });

  it('matches physics spring tokens (damping 14, stiffness 120, mass 0.8)', () => {
    expect(SPRING_PHYSICS.damping).toBe(14);
    expect(SPRING_PHYSICS.stiffness).toBe(120);
    expect(SPRING_PHYSICS.mass).toBe(0.8);
  });

  it('adheres to Safe Zone specs', () => {
    expect(SAFE_ZONES.top).toBe(140);
    expect(SAFE_ZONES.bottom).toBe(300);
    expect(SAFE_ZONES.right).toBe(120);
    expect(SAFE_ZONES.left).toBe(40);
  });
});

describe('VideoCompositionProps Schema & Builder (T3.5)', () => {
  it('validates createSampleCompositionProps() against Zod schema', () => {
    const sampleProps = createSampleCompositionProps();
    const parsed = VideoCompositionPropsSchema.safeParse(sampleProps);
    expect(parsed.success).toBe(true);
  });

  it('buildVideoCompositionProps creates a valid schema-compliant object', () => {
    const directorScript: AIDirectorOutput = {
      id: 'dir_test_01',
      postId: 'p_01',
      modelName: 'deterministic-rule-director-v1',
      hookLines: ['LƯƠNG 9TR2', 'CUỐI NĂM THƯỞNG 50 CỦ?'],
      selectedCommentIds: [],
      segments: [
        {
          segmentId: 'post_p1',
          kind: 'MAIN_POST',
          authorHandle: 'test_user',
          displayText: 'Đi làm lương 9tr2 sếp hứa thưởng 50 củ khoai',
          ttsText: 'Đi làm lương chín triệu hai sếp hứa thưởng năm mươi củ khoai',
          imageIndexes: [],
          audioCues: [],
          visualCues: [],
        },
      ],
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      createdAt: 1764176400,
    };

    const scrapedPost: NormalizedThreadsPost = {
      id: 'p_01',
      shortcode: 'C8AbCdEf123',
      sourceUrl: 'https://www.threads.net/@test_user/post/C8AbCdEf123',
      authorHandle: 'test_user',
      authorDisplayName: 'Test User',
      isVerified: true,
      authorAvatarPath: '/tmp/avatar.webp',
      postedDisplayDate: '1h',
      rawText: 'Đi làm lương 9tr2 sếp hứa thưởng 50 củ khoai',
      images: [],
      strippedVideoCount: 0,
      metrics: { likes: 100, replies: 10, reposts: 5, shares: 2 },
      topReplies: [],
      textLengthState: 'ST-LEN-01',
      mediaState: 'ST-MED-01',
      commentState: 'ST-COM-01',
      expiresAt: 1764176400 + 86400,
      createdAt: 1764176400,
    };

    const synthSegments: SynthesizedSegmentAudio[] = [
      {
        segmentId: 'post_p1',
        kind: 'MAIN_POST',
        wavPath: '/tmp/v1.wav',
        durationMs: 3000,
        numSamples: 144000,
        sampleRate: 48000,
        channels: 1,
        trimmedLeadingMs: 0,
        wordTimings: [
          { word: 'Đi', startMs: 0, endMs: 200 },
          { word: 'làm', startMs: 200, endMs: 400 },
        ],
        backendUsed: 'vieneu_gpu',
      },
    ];

    const props = buildVideoCompositionProps({
      jobId: 'job_test_01',
      directorScript,
      synthesizedSegments: synthSegments,
      masterAudioPath: '/tmp/master.wav',
      scrapedPost,
      fps: 60,
      theme: 'dark',
    });

    const parsed = VideoCompositionPropsSchema.safeParse(props);
    expect(parsed.success).toBe(true);
    expect(props.meta.width).toBe(1080);
    expect(props.meta.height).toBe(1920);
    expect(props.meta.fps).toBe(60);
    expect(props.segments).toHaveLength(1);
    expect(props.hookBanner.lines).toEqual(['LƯƠNG 9TR2', 'CUỐI NĂM THƯỞNG 50 CỦ?']);
  });

  it('calculateThreadsVideoMetadata dynamically resolves durationInFrames > 360 (e.g. 940 frames)', async () => {
    const sample = createSampleCompositionProps();
    const longProps = {
      ...sample,
      meta: { ...sample.meta, totalFrames: 940, fps: 60 as const },
    };

    const meta = await calculateThreadsVideoMetadata({
      defaultProps: sample,
      props: longProps,
      abortSignal: new AbortController().signal,
      compositionId: 'ThreadsVideo',
      isRendering: true,
    });

    expect(meta.durationInFrames).toBe(940);
    expect(meta.fps).toBe(60);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
  });

  it('ThreadsCard preserves 100% displayText verbatim ("9tr2", "50 củ") while mapping TTS wordTimings', () => {
    const displayText = 'Đi làm lương 9tr2 nhưng sếp hứa thưởng 50 củ khoai 🤡';
    const tokens = tokenizeDisplayText(displayText);
    expect(tokens).toContain('9tr2');
    expect(tokens).toContain('50');
    expect(tokens).toContain('củ');
    expect(tokens.join(' ')).not.toContain('chín triệu hai');

    const ttsWordTimings = [
      { word: 'Đi', startLocalFrame: 0, endLocalFrame: 12 },
      { word: 'làm', startLocalFrame: 13, endLocalFrame: 24 },
      { word: 'lương', startLocalFrame: 25, endLocalFrame: 36 },
      { word: 'chín', startLocalFrame: 37, endLocalFrame: 48 },
      { word: 'triệu', startLocalFrame: 49, endLocalFrame: 60 },
      { word: 'hai', startLocalFrame: 61, endLocalFrame: 72 },
    ];

    const startIdx = computeDisplayTextActiveTokenIndex(displayText, ttsWordTimings, 5);
    const midIdx = computeDisplayTextActiveTokenIndex(displayText, ttsWordTimings, 40);
    const endIdx = computeDisplayTextActiveTokenIndex(displayText, ttsWordTimings, 65);

    expect(startIdx).toBe(0);
    expect(midIdx).toBeGreaterThan(0);
    expect(endIdx).toBe(tokens.length - 1);
  });

  it('buildVideoCompositionProps aligns visualCue triggerLocalFrame from wordTimings (not hardcoded 30%)', () => {
    const directorScript: AIDirectorOutput = {
      id: 'dir_cue_01',
      postId: 'p_cue',
      modelName: 'test',
      hookLines: ['HOOK'],
      selectedCommentIds: [],
      segments: [
        {
          segmentId: 'post_p1',
          kind: 'MAIN_POST',
          authorHandle: 'u',
          displayText: 'Đi làm lương 9tr2 sếp bắt tăng ca',
          ttsText: 'Đi làm lương chín triệu hai sếp bắt tăng ca',
          imageIndexes: [],
          audioCues: [],
          visualCues: [
            {
              cueId: 'vc_1',
              stickerCode: 'clown',
              triggerWord: 'tăng ca',
              position: 'TOP_RIGHT',
              animation: 'POP_BOUNCE',
            },
          ],
        },
      ],
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      createdAt: 1764176400,
    };

    const synthSegments: SynthesizedSegmentAudio[] = [
      {
        segmentId: 'post_p1',
        kind: 'MAIN_POST',
        wavPath: '/tmp/v1.wav',
        durationMs: 3000,
        numSamples: 144000,
        sampleRate: 48000,
        channels: 1,
        trimmedLeadingMs: 0,
        wordTimings: [
          { word: 'Đi', startMs: 0, endMs: 200 },
          { word: 'tăng', startMs: 2100, endMs: 2400 },
          { word: 'ca', startMs: 2400, endMs: 2800 },
        ],
        backendUsed: 'vieneu_gpu',
      },
    ];

    const props = buildVideoCompositionProps({
      jobId: 'job_cue_01',
      directorScript,
      synthesizedSegments: synthSegments,
      masterAudioPath: path.join(resolveRemotionPublicDir(), 'output', 'master.wav'),
      fps: 60,
    });

    // 2100ms @ 60fps = 126 frames (far from old 30% = ~60 frames)
    expect(props.segments[0]?.visualCues[0]?.triggerLocalFrame).toBe(126);
    expect(props.audio.masterAudioSrc).toBe('output/master.wav');
  });
});
