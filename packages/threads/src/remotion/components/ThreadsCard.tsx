import type React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  FONT_FAMILY,
  LAYOUT_CENTER,
  SPRING_PHYSICS,
  getThemeColors,
} from '../constants.js';
import type { Theme } from '../../contracts/common.js';
import type { CompositionSegment } from '../../contracts/video-composition.js';

type CardWordTiming = NonNullable<CompositionSegment['card']['wordTimings']>[number];

interface ThreadsCardProps {
  segment: CompositionSegment;
  theme: Theme;
  commentIndex?: number;
}

const STICKER_EMOJIS: Record<string, string> = {
  clown: '🤡',
  skull: '💀',
  laugh_cry: '😂',
  question: '❓',
  fire: '🔥',
};

/**
 * Splits `displayText` into non-empty word tokens preserving exact original Threads text
 * (e.g. "9tr2", "50 củ", teencode, emojis).
 */
export function tokenizeDisplayText(displayText: string): string[] {
  return displayText
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);
}

/**
 * Maps current playback frame against `wordTimings` (from TTS alignment) onto the
 * corresponding token index of `displayText` proportionally, so `displayText` is
 * preserved 100% verbatim while highlighting advances smoothly in sync with speech.
 */
export function computeDisplayTextActiveTokenIndex(
  displayText: string,
  wordTimings: readonly CardWordTiming[] | undefined,
  localFrame: number,
): number {
  const displayTokens = tokenizeDisplayText(displayText);
  if (displayTokens.length === 0 || !wordTimings || wordTimings.length === 0) {
    return -1;
  }

  let timingIdx = wordTimings.findIndex(
    (w) => localFrame >= w.startLocalFrame && localFrame <= w.endLocalFrame,
  );

  // Between words: hold the most recently started word if speech is still ongoing
  if (timingIdx === -1) {
    const lastTiming = wordTimings[wordTimings.length - 1]!;
    if (localFrame < wordTimings[0]!.startLocalFrame || localFrame > lastTiming.endLocalFrame) {
      return -1;
    }
    for (let i = wordTimings.length - 1; i >= 0; i -= 1) {
      if (localFrame >= wordTimings[i]!.startLocalFrame) {
        timingIdx = i;
        break;
      }
    }
  }

  if (timingIdx < 0) {
    return -1;
  }

  if (wordTimings.length === 1) {
    return 0;
  }

  const ratio = timingIdx / Math.max(1, wordTimings.length - 1);
  return Math.min(
    displayTokens.length - 1,
    Math.max(0, Math.round(ratio * (displayTokens.length - 1))),
  );
}

export const ThreadsCard: React.FC<ThreadsCardProps> = ({
  segment,
  theme,
  commentIndex,
}) => {
  const localFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const colors = getThemeColors(theme);
  const card = segment.card;
  const isComment = segment.kind === 'COMMENT';

  // Smooth spring enter (damping: 14, stiffness: 120, mass: 0.8)
  const enterProgress = spring({
    frame: localFrame,
    fps,
    config: SPRING_PHYSICS,
  });

  // Subtle smooth fade/scale out over the final 8 frames
  const exitFrames = 8;
  const exitStart = Math.max(0, segment.durationInFrames - exitFrames);
  const exitOpacity =
    segment.durationInFrames > exitFrames * 2
      ? interpolate(localFrame, [exitStart, segment.durationInFrames], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const enterTranslateY = interpolate(enterProgress, [0, 1], [56, 0]);
  const enterScale = interpolate(enterProgress, [0, 1], [0.94, 1]);
  const cardOpacity = Math.min(enterProgress, exitOpacity);

  const fontSize =
    card.textLengthState === 'ST-LEN-01' || card.textLengthState === 'ST-LEN-02'
      ? 40
      : card.textLengthState === 'ST-LEN-03'
        ? 34
        : 30;

  const displayTokens = tokenizeDisplayText(card.displayText);
  const activeDisplayIdx = computeDisplayTextActiveTokenIndex(
    card.displayText,
    card.wordTimings,
    localFrame,
  );

  const accentBorderColor = isComment
    ? theme === 'dark'
      ? 'rgba(56, 151, 240, 0.35)'
      : 'rgba(0, 149, 246, 0.28)'
    : colors.card.border;

  return (
    <div
      style={{
        position: 'absolute',
        top: '54%',
        left: '50%',
        width: LAYOUT_CENTER.cardWidth,
        transform: `translate(-50%, -50%) translateY(${enterTranslateY}px) scale(${enterScale})`,
        transformOrigin: 'center center',
        opacity: cardOpacity,
        backgroundColor: colors.card.background,
        borderRadius: 36,
        border: `2px solid ${accentBorderColor}`,
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.50)',
        padding: 44,
        zIndex: 30,
        fontFamily: FONT_FAMILY,
      }}
    >
      {/* Comment Distinction: Top Reply / Comment #N badge */}
      {isComment && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 20,
          }}
        >
          <span
            style={{
              padding: '6px 16px',
              borderRadius: 10,
              backgroundColor:
                commentIndex === 1
                  ? 'rgba(255, 215, 0, 0.16)'
                  : 'rgba(56, 151, 240, 0.16)',
              color: commentIndex === 1 ? colors.text.highlight : colors.text.link,
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '0.02em',
            }}
          >
            {commentIndex === 1
              ? 'Top Reply • Bình luận #1'
              : `Bình luận #${commentIndex ?? 1}`}
          </span>
          {card.replyingToHandle && (
            <span style={{ fontSize: 24, color: colors.text.secondary, fontWeight: 500 }}>
              Trả lời @{card.replyingToHandle}
            </span>
          )}
        </div>
      )}

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          {card.authorAvatarSrc ? (
            <img
              src={card.authorAvatarSrc}
              alt=""
              style={{
                width: 80,
                height: 80,
                borderRadius: '50%',
                objectFit: 'cover',
                backgroundColor: colors.card.backgroundSubtle,
                border: `2px solid ${colors.card.border}`,
              }}
            />
          ) : (
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: '50%',
                backgroundColor: colors.card.backgroundSubtle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 32,
                fontWeight: 700,
                color: colors.text.secondary,
              }}
            >
              {card.authorHandle.slice(0, 1).toUpperCase()}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 32,
                  fontWeight: 700,
                  color: colors.text.primary,
                }}
              >
                {card.authorDisplayName || card.authorHandle}
              </span>
              {card.isVerified && (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#0095F6">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                </svg>
              )}
            </div>
            <span style={{ fontSize: 24, color: colors.text.secondary }}>
              @{card.authorHandle} • {card.postedDateLabel}
            </span>
          </div>
        </div>

        {card.pageIndicator && (
          <div
            style={{
              padding: '6px 18px',
              borderRadius: 999,
              backgroundColor: colors.badge.background,
              color: colors.badge.text,
              fontSize: 22,
              fontWeight: 700,
            }}
          >
            Trang {card.pageIndicator.current}/{card.pageIndicator.total}
          </div>
        )}
      </div>

      {/* Body Wrapper with Subtle Vertical Thread Line for Comments */}
      <div
        style={{
          display: 'flex',
          gap: isComment ? 22 : 0,
          marginBottom: 28,
        }}
      >
        {isComment && (
          <div
            style={{
              width: 4,
              borderRadius: 4,
              backgroundColor: '#333333',
              flexShrink: 0,
              marginLeft: 38,
            }}
          />
        )}

        {/* Card Body Text — 100% displayText verbatim, zero reflow/jitter */}
        <div
          style={{
            flex: 1,
            fontSize,
            fontWeight: 500,
            lineHeight: 1.45,
            color: colors.text.primary,
            wordBreak: 'break-word',
          }}
        >
          {displayTokens.map((token, idx) => {
            const isHighlight = idx === activeDisplayIdx;
            return (
              <span
                key={idx}
                style={{
                  backgroundColor: isHighlight ? colors.text.highlight : 'transparent',
                  color: isHighlight ? '#0A0A0C' : colors.text.primary,
                  padding: '2px 5px',
                  borderRadius: 8,
                  marginRight: 4,
                  display: 'inline-block',
                  boxShadow: isHighlight ? '0 4px 14px rgba(255, 215, 0, 0.35)' : 'none',
                }}
              >
                {token}
              </span>
            );
          })}
        </div>
      </div>

      {/* Attached Images */}
      {card.images && card.images.length > 0 && (
        <div style={{ display: 'flex', gap: 14, marginBottom: 28, overflow: 'hidden' }}>
          {card.images.slice(0, 2).map((img, idx) => (
            <img
              key={idx}
              src={img.src}
              alt=""
              style={{
                flex: 1,
                maxHeight: 460,
                borderRadius: 24,
                objectFit: 'cover',
                border: `1px solid ${colors.card.border}`,
              }}
            />
          ))}
        </div>
      )}

      {/* Footer Metrics */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 40,
          paddingTop: 20,
          borderTop: `1px solid ${colors.card.divider}`,
          color: colors.text.secondary,
          fontSize: 26,
          fontWeight: 600,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <span>{card.metrics.likes.toLocaleString('vi-VN')}</span>
        </div>

        {card.metrics.replies !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            <span>{card.metrics.replies.toLocaleString('vi-VN')}</span>
          </div>
        )}

        {card.metrics.reposts !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M17 1l4 4-4 4" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <path d="M7 23l-4-4 4-4" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            <span>{card.metrics.reposts.toLocaleString('vi-VN')}</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </div>
      </div>

      {/* Visual Cues (Meme Stickers with Spring Physics) */}
      {segment.visualCues.map((cue) => {
        const isTriggered =
          localFrame >= cue.triggerLocalFrame &&
          localFrame < cue.triggerLocalFrame + cue.durationInFrames;
        if (!isTriggered) return null;

        const stickerFrame = localFrame - cue.triggerLocalFrame;
        const stickerScale = spring({
          frame: stickerFrame,
          fps,
          config: SPRING_PHYSICS,
        });
        const shakeDeg =
          cue.animation === 'SHAKE' ? Math.sin(stickerFrame * 0.9) * 10 : 0;

        const emoji = STICKER_EMOJIS[cue.stickerCode] ?? '🔥';

        let posStyle: React.CSSProperties = { top: -48, right: -24 };
        let transform = `scale(${stickerScale}) rotate(${shakeDeg}deg)`;
        if (cue.position === 'BOTTOM_RIGHT') {
          posStyle = { bottom: -36, right: -24 };
        } else if (cue.position === 'CENTER_CARD') {
          posStyle = { top: '50%', left: '50%' };
          transform = `translate(-50%, -50%) scale(${stickerScale}) rotate(${shakeDeg}deg)`;
        }

        return (
          <div
            key={cue.cueId}
            style={{
              position: 'absolute',
              ...posStyle,
              fontSize: 108,
              lineHeight: 1,
              fontFamily: FONT_FAMILY,
              filter: 'drop-shadow(0 14px 28px rgba(0,0,0,0.55))',
              transform,
              zIndex: 60,
              pointerEvents: 'none',
            }}
          >
            {emoji}
          </div>
        );
      })}
    </div>
  );
};
