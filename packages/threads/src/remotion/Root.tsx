import type React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { ThreadsVideo } from './ThreadsVideo.js';
import { CANVAS_HEIGHT, CANVAS_WIDTH, DEFAULT_FPS } from './constants.js';
import { createSampleCompositionProps } from './sample-props.js';
import {
  VideoCompositionPropsSchema,
  type VideoCompositionProps,
} from '../contracts/video-composition.js';

export const calculateThreadsVideoMetadata: CalculateMetadataFunction<
  VideoCompositionProps
> = ({ props }) => ({
  durationInFrames: props.meta.totalFrames,
  fps: props.meta.fps,
  width: props.meta.width,
  height: props.meta.height,
});

export const RemotionRoot: React.FC = () => {
  const sampleProps = createSampleCompositionProps();

  return (
    <>
      <Composition
        id="ThreadsVideo"
        component={ThreadsVideo}
        durationInFrames={sampleProps.meta.totalFrames}
        fps={DEFAULT_FPS}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        defaultProps={sampleProps}
        schema={VideoCompositionPropsSchema}
        calculateMetadata={calculateThreadsVideoMetadata}
      />
    </>
  );
};
