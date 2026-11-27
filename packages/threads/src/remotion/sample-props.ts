import path from 'node:path';
import type { VideoCompositionProps } from '../contracts/video-composition.js';
import { resolveThreadsAssetsDir } from '../paths.js';

export function createSampleCompositionProps(): VideoCompositionProps {
  const assetsDir = resolveThreadsAssetsDir();
  const bgPath = path.join(assetsDir, 'gameplay', 'default.mp4');
  const audioPath = path.join(assetsDir, 'bgm', 'default.wav');

  return {
    meta: {
      jobId: 'demo-threads-sample-01',
      width: 1080,
      height: 1920,
      fps: 60,
      totalFrames: 360,
      theme: 'dark',
    },
    background: {
      videoSrc: bgPath,
      startFromFrame: 0,
      dimOpacity: 0.45,
    },
    audio: {
      masterAudioSrc: audioPath,
    },
    hookBanner: {
      lines: ['BỊ BÓC LỘT CÔNG SỨC', 'CÔ GÁI NGHỈ VIỆC NGAY TỨC THÌ'],
      styleVariant: 'white-pill',
    },
    segments: [
      {
        segmentId: 'seg-main-post',
        kind: 'MAIN_POST',
        startFrame: 0,
        durationInFrames: 180,
        transitionIn: 'SPRING_POP',
        card: {
          authorHandle: 'thanhhang.dev',
          authorDisplayName: 'Thanh Hằng',
          isVerified: true,
          authorAvatarSrc: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%234A5568"/><text x="50" y="65" font-size="45" text-anchor="middle" fill="white">T</text></svg>',
          postedDateLabel: '2 giờ',
          textLengthState: 'ST-LEN-02',
          displayText: 'Công ty bắt OT không lương suốt 3 tháng, hôm nay em chính thức nộp đơn xin nghỉ việc!',
          images: [],
          metrics: {
            likes: 12540,
            replies: 843,
            reposts: 520,
            shares: 310,
          },
        },
        visualCues: [
          {
            cueId: 'cue-fire',
            stickerCode: 'fire',
            position: 'TOP_RIGHT',
            triggerLocalFrame: 40,
            durationInFrames: 60,
            animation: 'POP_BOUNCE',
          },
        ],
      },
      {
        segmentId: 'seg-comment-1',
        kind: 'COMMENT',
        startFrame: 180,
        durationInFrames: 180,
        transitionIn: 'SPRING_POP',
        card: {
          authorHandle: 'minh.designer',
          authorDisplayName: 'Minh Hoàng',
          isVerified: false,
          authorAvatarSrc: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%232B6CB0"/><text x="50" y="65" font-size="45" text-anchor="middle" fill="white">M</text></svg>',
          postedDateLabel: '1 giờ',
          replyingToHandle: 'thanhhang.dev',
          pageIndicator: { current: 1, total: 3 },
          textLengthState: 'ST-LEN-02',
          displayText: 'Ủng hộ bạn 100%! Đi làm kiếm tiền chứ có phải đi làm từ thiện đâu mà bóc lột thế.',
          images: [],
          metrics: {
            likes: 3410,
            replies: 42,
          },
        },
        visualCues: [
          {
            cueId: 'cue-laugh',
            stickerCode: 'laugh_cry',
            position: 'TOP_RIGHT',
            triggerLocalFrame: 40,
            durationInFrames: 60,
            animation: 'POP_BOUNCE',
          },
        ],
      },
    ],
  };
}
