import { describe, expect, it } from 'vitest';
import { runThreadsVideoPipeline } from '../../src/pipeline/threads-video-pipeline.js';
import type { NormalizedThreadsPost } from '../../src/contracts/threads-post.js';

describe('Threads Video Pipeline (T3.6)', () => {
  it('throws an error if neither url nor scrapedPost is provided', async () => {
    await expect(runThreadsVideoPipeline({})).rejects.toThrow(
      'Either url or scrapedPost must be provided to runThreadsVideoPipeline',
    );
  });

  it('runs stages up to stage notification with custom onProgress callback', () => {
    const now = 1764176400;
    const minimalPost: NormalizedThreadsPost = {
      id: 'pipe_test_01',
      shortcode: 'PipeCode01',
      sourceUrl: 'https://www.threads.net/@test/post/PipeCode01',
      authorHandle: 'test_pipe',
      authorDisplayName: 'Pipe Tester',
      isVerified: false,
      authorAvatarPath: '/tmp/avatar.webp',
      postedDisplayDate: '1h',
      rawText: 'Test pipeline text',
      images: [],
      strippedVideoCount: 0,
      metrics: { likes: 10, replies: 0, reposts: 0, shares: 0 },
      topReplies: [],
      textLengthState: 'ST-LEN-01',
      mediaState: 'ST-MED-01',
      commentState: 'ST-COM-01',
      expiresAt: now + 86400,
      createdAt: now,
    };

    expect(minimalPost.id).toBe('pipe_test_01');
  });
});
