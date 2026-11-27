import type { Fps } from '../contracts/index.js';
import type {
  AudioTimelineResult,
  QuantizedSegmentTiming,
  SynthesizedSegmentAudio,
  WordTimingFrame,
  WordTimingMs,
} from './types.js';

export const INTRO_PAD_MS = 200;
export const GAP_NEW_CARD_MS = 260;
export const GAP_NEXT_PAGE_MS = 140;
export const OUTRO_PAD_MS = 450;

function isSameCardTransition(
  current: SynthesizedSegmentAudio,
  next: SynthesizedSegmentAudio | undefined,
): boolean {
  if (!next) {
    return false;
  }
  if (current.kind === 'MAIN_POST' && next.kind === 'MAIN_POST') {
    return true;
  }
  if (
    current.kind === 'COMMENT' &&
    next.kind === 'COMMENT' &&
    current.sourceCommentId &&
    current.sourceCommentId === next.sourceCommentId
  ) {
    return true;
  }
  return false;
}

/**
 * Zero-Drift Audio-Driven Frame Quantizer (`ARCHITECTURE.md` 5.2):
 * Accumulates exact physical PCM durations (`numSamples / 48.0` ms) on the millisecond axis
 * before quantizing to integer frames, guaranteeing:
 * - `startFrame_{i+1} === endFrame_i` (zero black frames between sequences)
 * - `|syncDriftMs| <= 500 / fps` (<= 0.5 frame: <= 8.33ms @ 60fps, <= 16.67ms @ 30fps)
 */
export function quantizeAudioTimeline(
  segments: readonly SynthesizedSegmentAudio[],
  fps: Fps,
): AudioTimelineResult {
  if (segments.length === 0) {
    return {
      fps,
      totalDurationMs: 0,
      totalFrames: 0,
      maxSyncDriftMs: 0,
      quantizedSegments: [],
    };
  }

  const quantizedSegments: QuantizedSegmentTiming[] = [];
  let cumulativeMs = INTRO_PAD_MS;
  let maxSyncDriftMs = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const next = segments[i + 1];
    const isLast = i === segments.length - 1;

    const exactDurationMs =
      seg.numSamples > 0 ? (seg.numSamples / seg.sampleRate) * 1000 : seg.durationMs;

    const gapAfterMs = isLast
      ? OUTRO_PAD_MS
      : isSameCardTransition(seg, next)
        ? GAP_NEXT_PAGE_MS
        : GAP_NEW_CARD_MS;

    const startMs = cumulativeMs;
    const endMs = startMs + exactDurationMs + gapAfterMs;

    const startFrame = Math.round((startMs / 1000) * fps);
    const endFrame = Math.max(startFrame + 1, Math.round((endMs / 1000) * fps));
    const durationInFrames = endFrame - startFrame;

    const quantizedStartMs = (startFrame / fps) * 1000;
    const syncDriftMs = Number((quantizedStartMs - startMs).toFixed(3));
    maxSyncDriftMs = Math.max(maxSyncDriftMs, Math.abs(syncDriftMs));

    const wordTimingsFrames: WordTimingFrame[] = seg.wordTimings.map((wt) => {
      const globalStartFrame = Math.round(((startMs + wt.startMs) / 1000) * fps);
      const globalEndFrame = Math.round(((startMs + wt.endMs) / 1000) * fps);
      const startLocalFrame = Math.max(0, globalStartFrame - startFrame);
      const endLocalFrame = Math.min(
        durationInFrames,
        Math.max(startLocalFrame + 1, globalEndFrame - startFrame),
      );
      return {
        word: wt.word,
        startLocalFrame,
        endLocalFrame,
      };
    });

    quantizedSegments.push({
      segmentId: seg.segmentId,
      kind: seg.kind,
      startMs: Number(startMs.toFixed(3)),
      endMs: Number(endMs.toFixed(3)),
      audioDurationMs: Number(exactDurationMs.toFixed(3)),
      gapAfterMs,
      startFrame,
      endFrame,
      durationInFrames,
      syncDriftMs,
      wordTimingsFrames,
    });

    cumulativeMs = endMs;
  }

  const lastSegment = quantizedSegments[quantizedSegments.length - 1]!;
  return {
    fps,
    totalDurationMs: Number(cumulativeMs.toFixed(3)),
    totalFrames: lastSegment.endFrame,
    maxSyncDriftMs: Number(maxSyncDriftMs.toFixed(3)),
    quantizedSegments,
  };
}

function normalizeTokenForMatch(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Resolves a contextual SFX/Sticker cue `triggerWord` (single word or multi-word phrase)
 * to its exact millisecond offset inside a segment:
 * 1. Exact phrase/token match against `wordTimings` (case- and punctuation-insensitive).
 * 2. Proportional position fallback inside `segmentText` if `wordTimings` is empty or unmatched.
 * 3. Midpoint fallback (`segmentDurationMs * 0.5`) if still unmatched.
 */
export function resolveTriggerTimeMs(
  triggerWord: string,
  wordTimings: readonly WordTimingMs[],
  segmentDurationMs: number,
  segmentText?: string,
): number {
  const cleanedPhrase = triggerWord.trim().toLowerCase();
  if (!cleanedPhrase || segmentDurationMs <= 0) {
    return 0;
  }

  const targetTokens = cleanedPhrase
    .split(/\s+/)
    .map(normalizeTokenForMatch)
    .filter((t) => t.length > 0);

  if (targetTokens.length > 0 && wordTimings.length > 0) {
    const timingTokens = wordTimings.map((wt) => normalizeTokenForMatch(wt.word));

    // 1a. Multi-word consecutive phrase match
    if (targetTokens.length > 1) {
      for (let i = 0; i <= timingTokens.length - targetTokens.length; i += 1) {
        let allMatch = true;
        for (let j = 0; j < targetTokens.length; j += 1) {
          if (timingTokens[i + j] !== targetTokens[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          return Math.max(0, Math.min(segmentDurationMs, wordTimings[i]!.startMs));
        }
      }
    }

    // 1b. Exact single-token match (prefer first target token)
    const firstTarget = targetTokens[0]!;
    for (let i = 0; i < timingTokens.length; i += 1) {
      if (timingTokens[i] === firstTarget) {
        return Math.max(0, Math.min(segmentDurationMs, wordTimings[i]!.startMs));
      }
    }

    // 1c. Substring match on normalized token
    for (let i = 0; i < timingTokens.length; i += 1) {
      const tok = timingTokens[i]!;
      if (tok.length > 0 && (tok.includes(firstTarget) || firstTarget.includes(tok))) {
        return Math.max(0, Math.min(segmentDurationMs, wordTimings[i]!.startMs));
      }
    }
  }

  // 2. Proportional position fallback in segmentText
  if (segmentText && segmentText.trim().length > 0) {
    const lowerText = segmentText.toLowerCase();
    const charIdx = lowerText.indexOf(cleanedPhrase);
    if (charIdx >= 0) {
      const ratio = charIdx / Math.max(1, lowerText.length);
      return Math.round(ratio * segmentDurationMs);
    }
  }

  // 3. Safe midpoint fallback
  return Math.round(segmentDurationMs * 0.5);
}

/**
 * Legacy alias preserved for backward compatibility.
 */
export function findTriggerWordOffsetMs(
  wordTimings: readonly WordTimingMs[],
  triggerWord: string,
  fallbackDurationMs: number,
  segmentText?: string,
): number {
  return resolveTriggerTimeMs(triggerWord, wordTimings, fallbackDurationMs, segmentText);
}
