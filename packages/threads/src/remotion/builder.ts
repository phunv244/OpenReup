import path from 'node:path';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type Fps,
  type Theme,
} from '../contracts/common.js';
import type { AIDirectorOutput } from '../contracts/ai-director.js';
import {
  classifyTextLengthState,
  type NormalizedThreadsPost,
} from '../contracts/threads-post.js';
import {
  VideoCompositionPropsSchema,
  type CompositionCard,
  type CompositionSegment,
  type CompositionVisualCue,
  type HookBannerStyleVariant,
  type VideoCompositionProps,
} from '../contracts/video-composition.js';
import {
  quantizeAudioTimeline,
  resolveTriggerTimeMs,
} from '../audio/timeline-quantizer.js';
import type { SynthesizedSegmentAudio } from '../audio/types.js';
import { resolveRemotionPublicDir, resolveThreadsAssetsDir } from '../paths.js';
import { toPublicRelativePath } from './renderer.js';

export interface BuildVideoCompositionPropsOptions {
  jobId: string;
  directorScript: AIDirectorOutput;
  synthesizedSegments: readonly SynthesizedSegmentAudio[];
  masterAudioPath: string;
  scrapedPost?: NormalizedThreadsPost;
  backgroundVideoPath?: string;
  theme?: Theme;
  fps?: Fps;
  dimOpacity?: number;
  hookBannerStyleVariant?: HookBannerStyleVariant;
}

function buildFallbackAvatarSvg(letter: string): string {
  const char = (letter.trim()[0] || 'U').toUpperCase();
  return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%233B4252"/><text x="50" y="65" font-family="Noto Sans, sans-serif" font-weight="700" font-size="45" text-anchor="middle" fill="white">${char}</text></svg>`;
}

export function buildVideoCompositionProps(
  options: BuildVideoCompositionPropsOptions,
): VideoCompositionProps {
  const {
    jobId,
    directorScript,
    synthesizedSegments,
    masterAudioPath,
    scrapedPost,
    theme = 'dark',
    fps = 60,
    dimOpacity = 0.4,
    hookBannerStyleVariant = 'white-pill',
  } = options;

  const publicDir = resolveRemotionPublicDir();
  const assetsDir = resolveThreadsAssetsDir();
  const bgVideoPath = toPublicRelativePath(
    options.backgroundVideoPath || path.join(assetsDir, 'gameplay', 'default.mp4'),
    publicDir,
  );
  const relMasterAudioPath = toPublicRelativePath(masterAudioPath, publicDir);

  // Quantize timeline to zero-drift frame intervals
  const timeline = quantizeAudioTimeline(synthesizedSegments, fps);

  // Map director segments into composition segments
  const segments: CompositionSegment[] = directorScript.segments.map((dirSeg, idx) => {
    const synthSeg =
      synthesizedSegments.find((s) => s.segmentId === dirSeg.segmentId) ??
      synthesizedSegments[idx];
    const timing = timeline.quantizedSegments.find((t) => t.segmentId === dirSeg.segmentId) ||
      timeline.quantizedSegments[idx] || {
        segmentId: dirSeg.segmentId,
        startFrame: idx * 180,
        endFrame: (idx + 1) * 180,
        durationInFrames: 180,
        audioDurationMs: 3000,
        wordTimingsFrames: [],
      };

    const isMain = dirSeg.kind === 'MAIN_POST';
    const authorHandle =
      dirSeg.authorHandle ||
      (isMain ? (scrapedPost?.authorHandle ?? 'threader') : `reply_${idx}`);

    const matchingReply = !isMain
      ? scrapedPost?.topReplies.find(
          (r) =>
            r.id === dirSeg.sourceCommentId ||
            r.authorHandle.toLowerCase() === authorHandle.toLowerCase() ||
            r.id === dirSeg.segmentId,
        )
      : undefined;

    const authorDisplayName = isMain
      ? (scrapedPost?.authorDisplayName ?? scrapedPost?.authorHandle ?? authorHandle)
      : (matchingReply?.authorDisplayName ?? authorHandle);

    const isVerified = isMain
      ? (scrapedPost?.isVerified ?? false)
      : (matchingReply?.isVerified ?? false);

    const mainAvatar = scrapedPost?.authorAvatarPath?.trim();
    const commentAvatar = matchingReply?.authorAvatarSrc?.trim();
    const rawAvatar = isMain ? mainAvatar : commentAvatar;
    const authorAvatarSrc =
      rawAvatar && rawAvatar.length > 0 && !rawAvatar.startsWith('/tmp/')
        ? toPublicRelativePath(rawAvatar, publicDir)
        : buildFallbackAvatarSvg(authorDisplayName || authorHandle);

    const postedDateLabel = isMain
      ? (scrapedPost?.postedDisplayDate ?? 'Vừa xong')
      : (matchingReply?.postedDateLabel ?? `${idx * 15 + 5}p`);

    const textLengthState = classifyTextLengthState(dirSeg.displayText);

    const card: CompositionCard = {
      authorHandle,
      authorDisplayName,
      isVerified,
      authorAvatarSrc,
      postedDateLabel,
      replyingToHandle: dirSeg.replyingToHandle,
      pageIndicator: dirSeg.pageIndicator,
      textLengthState,
      displayText: dirSeg.displayText,
      wordTimings: timing.wordTimingsFrames,
      images:
        isMain && scrapedPost?.images
          ? scrapedPost.images.slice(0, 4).map((img) => ({
              src: toPublicRelativePath(img.src, publicDir),
              width: img.width ?? 800,
              height: img.height ?? 800,
              aspectRatio: img.width && img.height ? img.width / img.height : 1,
            }))
          : [],
      metrics: {
        likes: isMain
          ? (scrapedPost?.metrics.likes ?? 1280)
          : (matchingReply?.likes ?? Math.max(10, 500 - idx * 80)),
        replies: isMain ? scrapedPost?.metrics.replies : undefined,
        reposts: isMain ? scrapedPost?.metrics.reposts : undefined,
        shares: isMain ? scrapedPost?.metrics.shares : undefined,
      },
    };

    const segDurMs = synthSeg?.durationMs ?? (timing.durationInFrames / fps) * 1000;
    const wordTimingsMs = synthSeg?.wordTimings ?? [];

    const visualCues: CompositionVisualCue[] = dirSeg.visualCues.map((vc, vIdx) => {
      const triggerOffsetMs = resolveTriggerTimeMs(
        vc.triggerWord,
        wordTimingsMs,
        segDurMs,
        dirSeg.ttsText,
      );
      const rawTriggerFrame = Math.round((triggerOffsetMs / 1000) * fps);
      const maxTriggerFrame = Math.max(0, timing.durationInFrames - 20);
      const triggerLocalFrame = Math.min(Math.max(0, rawTriggerFrame), maxTriggerFrame);
      const cueDuration = Math.min(
        Math.max(30, fps),
        Math.max(20, timing.durationInFrames - triggerLocalFrame),
      );

      return {
        cueId: vc.cueId || `cue-${idx}-${vIdx}`,
        triggerLocalFrame,
        durationInFrames: cueDuration,
        stickerCode: vc.stickerCode,
        position: vc.position,
        animation: vc.animation,
      };
    });

    return {
      segmentId: dirSeg.segmentId,
      kind: dirSeg.kind,
      startFrame: timing.startFrame,
      durationInFrames: timing.durationInFrames,
      transitionIn: 'SPRING_POP',
      card,
      visualCues,
    };
  });

  const totalFrames = Math.max(
    timeline.totalFrames,
    segments.reduce((max, s) => Math.max(max, s.startFrame + s.durationInFrames), 0),
  );

  const rawProps: VideoCompositionProps = {
    meta: {
      jobId,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      fps,
      totalFrames,
      theme,
    },
    background: {
      videoSrc: bgVideoPath,
      startFromFrame: 0,
      dimOpacity,
    },
    audio: {
      masterAudioSrc: relMasterAudioPath,
    },
    hookBanner: {
      lines: directorScript.hookLines,
      styleVariant: hookBannerStyleVariant,
    },
    segments,
  };

  return VideoCompositionPropsSchema.parse(rawProps);
}
