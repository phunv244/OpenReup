import type React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_FAMILY, LAYOUT_CENTER, SPRING_PHYSICS } from '../constants.js';
import type { HookBannerStyleVariant } from '../../contracts/video-composition.js';

interface HookBannerProps {
  lines: string[];
  styleVariant: HookBannerStyleVariant;
}

export const HookBanner: React.FC<HookBannerProps> = ({ lines, styleVariant }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isDark = styleVariant === 'dark-pill';
  const bg = isDark ? '#0F0F12' : '#FFFFFF';
  const text = isDark ? '#FFFFFF' : '#0A0A0C';
  const border = isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.08)';

  const visibleLines = lines.slice(0, 2);

  return (
    <div
      style={{
        position: 'absolute',
        top: 168,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        paddingLeft: 70,
        paddingRight: 70,
        zIndex: 40,
        fontFamily: FONT_FAMILY,
      }}
    >
      {visibleLines.map((line, i) => {
        const lineScale = spring({
          frame: Math.max(0, frame - i * 4),
          fps,
          config: SPRING_PHYSICS,
        });

        return (
          <div
            key={i}
            style={{
              backgroundColor: bg,
              color: text,
              padding: '14px 32px',
              borderRadius: 16,
              border: `2px solid ${border}`,
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
              maxWidth: LAYOUT_CENTER.bannerMaxWidth,
              textAlign: 'center',
              fontSize: i === 0 ? 40 : 36,
              fontWeight: 800,
              lineHeight: 1.25,
              letterSpacing: '-0.02em',
              fontFamily: FONT_FAMILY,
              transform: `scale(${lineScale})`,
              transformOrigin: 'center center',
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};
