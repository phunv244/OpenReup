import type React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { getThemeColors } from '../constants.js';
import type { Theme } from '../../contracts/common.js';

export const ProgressBar: React.FC<{ theme: Theme }> = ({ theme }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const colors = getThemeColors(theme);
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames - 1)));

  return (
    <div
      style={{
        position: 'absolute',
        top: 24,
        left: 40,
        right: 40,
        height: 8,
        backgroundColor: colors.progressBar.track,
        borderRadius: 4,
        overflow: 'hidden',
        zIndex: 50,
      }}
    >
      <div
        style={{
          width: `${progress * 100}%`,
          height: '100%',
          backgroundColor: colors.progressBar.fill,
          borderRadius: 4,
        }}
      />
    </div>
  );
};
