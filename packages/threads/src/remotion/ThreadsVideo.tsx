import type React from 'react';
import { Audio, OffthreadVideo, Sequence, staticFile } from 'remotion';
import { FONT_FAMILY, getThemeColors } from './constants.js';
import { HookBanner } from './components/HookBanner.js';
import { ProgressBar } from './components/ProgressBar.js';
import { ThreadsCard } from './components/ThreadsCard.js';
import type { VideoCompositionProps } from '../contracts/video-composition.js';

function resolveStaticSrc(src: string): string {
  if (!src) return '';
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src;
  }
  return staticFile(src.replace(/^\/+/, ''));
}

export const ThreadsVideo: React.FC<VideoCompositionProps> = (props) => {
  const { meta, background, audio, hookBanner, segments } = props;
  const colors = getThemeColors(meta.theme);

  const bgVideoSrc = resolveStaticSrc(background.videoSrc);
  const masterAudioSrc = resolveStaticSrc(audio.masterAudioSrc);

  let commentCounter = 0;

  return (
    <div
      style={{
        width: meta.width,
        height: meta.height,
        position: 'relative',
        backgroundColor: colors.canvas.background,
        overflow: 'hidden',
        fontFamily: FONT_FAMILY,
      }}
    >
      {/* LAYER 1: Background Video with OffthreadVideo (Rust accelerated) + Scrim */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          zIndex: 1,
        }}
      >
        <OffthreadVideo
          src={bgVideoSrc}
          startFrom={background.startFromFrame}
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
        {/* Scrim Overlay */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: colors.canvas.scrim,
            opacity: background.dimOpacity,
          }}
        />
      </div>

      {/* LAYER 2: Master Audio Track (48,000 Hz Normalized -14 LUFS) */}
      {masterAudioSrc && <Audio src={masterAudioSrc} />}

      {/* LAYER 3: Hook Banner (Crisp Multi-line Pill Stack) */}
      <HookBanner lines={hookBanner.lines} styleVariant={hookBanner.styleVariant} />

      {/* LAYER 4: Card Sequence (Main Post + Comments with Spring Transitions) */}
      {segments.map((segment) => {
        const commentIndex = segment.kind === 'COMMENT' ? ++commentCounter : undefined;
        return (
          <Sequence
            key={segment.segmentId}
            from={segment.startFrame}
            durationInFrames={segment.durationInFrames}
          >
            <ThreadsCard
              segment={segment}
              theme={meta.theme}
              commentIndex={commentIndex}
            />
          </Sequence>
        );
      })}

      {/* LAYER 5: Top Progress Bar */}
      <ProgressBar theme={meta.theme} />
    </div>
  );
};
