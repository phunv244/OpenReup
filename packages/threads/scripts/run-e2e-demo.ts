import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { runThreadsVideoPipeline } from '../src/pipeline/threads-video-pipeline.js';
import type { NormalizedThreadsPost } from '../src/contracts/threads-post.js';

async function main() {
  console.log('=== [E2E DEMO] Running Full VideoThreads Pipeline ===');
  const now = Math.floor(Date.now() / 1000);
  const samplePost: NormalizedThreadsPost = {
    id: 'demo_post_e2e_01',
    shortcode: 'DEm0_P0st_01',
    sourceUrl: 'https://www.threads.net/@uyentich19/post/DEm0_P0st_01',
    authorHandle: 'uyentich19',
    authorDisplayName: 'Uyên Tịch',
    isVerified: true,
    postedDisplayDate: '11/02',
    rawText: 'Đi làm lương 9tr2 nhưng sếp hứa cuối năm thưởng 50 củ khoai, có nên tin không cả nhà?',
    images: [],
    strippedVideoCount: 0,
    metrics: { likes: 3500, replies: 120, reposts: 88, shares: 45 },
    topReplies: [
      {
        id: 'reply_01',
        authorHandle: 'minhanh_99',
        authorDisplayName: 'Minh Anh',
        isVerified: false,
        authorAvatarSrc: '/tmp/videothreads/avatar_01.webp',
        postedDateLabel: '2h',
        text: 'Tin sếp là mất tết đấy bạn ơi haha',
        likes: 420,
        strippedVideoCount: 0,
      },
      {
        id: 'reply_02',
        authorHandle: 'hoang_tuan',
        authorDisplayName: 'Hoàng Tuấn',
        isVerified: false,
        authorAvatarSrc: '/tmp/videothreads/avatar_02.webp',
        postedDateLabel: '1h',
        text: 'Hứa thật nhiều thất hứa thật nhiều nha sếp ơi',
        likes: 230,
        strippedVideoCount: 0,
      },
      {
        id: 'reply_03',
        authorHandle: 'lan_nguyen',
        authorDisplayName: 'Lan Nguyễn',
        isVerified: false,
        authorAvatarSrc: '/tmp/videothreads/avatar_03.webp',
        postedDateLabel: '30m',
        text: 'Cứ xin ứng trước 10tr tiêu tết rồi tính tiếp bạn nhé',
        likes: 150,
        strippedVideoCount: 0,
      },
    ],
    textLengthState: 'ST-LEN-01',
    mediaState: 'ST-MED-01',
    commentState: 'ST-COM-01',
    expiresAt: now + 86400,
    createdAt: now,
  };

  const jobId = `e2e_demo_${Date.now()}`;
  console.log(`Starting pipeline for jobId: ${jobId}`);

  const result = await runThreadsVideoPipeline({
    jobId,
    scrapedPost: samplePost,
    voiceId: 'Adam bựa',
    theme: 'dark',
    fps: 60,
    onProgress: (stage, percent) => {
      console.log(`  -> [${stage}] ${percent}%`);
    },
  });

  console.log('\n=== [PIPELINE SUCCESS] ===');
  console.log(`Job ID: ${result.jobId}`);
  console.log(`Video Output: ${result.videoPath} (${(result.fileSizeBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Preview Still: ${result.previewStillPath}`);
  console.log(`Master Audio: ${result.masterAudioPath}`);
  console.log(`Duration: ${result.durationSec.toFixed(2)}s (${result.totalFrames} frames @ ${result.fps}fps)`);
  console.log(`Render time: ${result.renderElapsedMs}ms, Total pipeline time: ${result.totalElapsedMs}ms`);

  // Probe output video with ffprobe
  const ffprobeBin = process.env['FFPROBE_BIN'] || process.env['REUP_FFPROBE'] || 'ffprobe';
  const probeOutput = execSync(
    `${ffprobeBin} -v quiet -print_format json -show_format -show_streams "${result.videoPath}"`,
    { encoding: 'utf-8' }
  );
  const probe = JSON.parse(probeOutput);
  const videoStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
  const audioStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');

  console.log('\n=== [FFPROBE VERIFICATION] ===');
  console.log(`Video Stream: ${videoStream?.codec_name} ${videoStream?.width}x${videoStream?.height} @ ${videoStream?.r_frame_rate} fps`);
  console.log(`Audio Stream: ${audioStream?.codec_name} ${audioStream?.sample_rate}Hz channels=${audioStream?.channels}`);
  console.log(`Container duration: ${probe.format?.duration}s, size: ${probe.format?.size} bytes`);

  if (videoStream?.width !== 1080 || videoStream?.height !== 1920) {
    throw new Error(`Invalid video resolution: ${videoStream?.width}x${videoStream?.height}, expected 1080x1920`);
  }
  if (!audioStream) {
    throw new Error('Missing audio stream in rendered video');
  }

  console.log('\n>>> ALL ACCEPTANCE CHECKS PASSED FOR E2E PIPELINE <<<');
}

main().catch((err) => {
  console.error('E2E Pipeline execution failed:', err);
  process.exit(1);
});
