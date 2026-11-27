import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_ID,
  type AIDirectorOutput,
  type NormalizedThreadsPost,
  type RenderJob,
} from '../../src/contracts/index.js';
import {
  DirectorScriptRepository,
  MediaAssetRepository,
  PostRepository,
  RenderJobRepository,
  getDatabasePragmas,
  openDatabase,
  runMigrations,
} from '../../src/db/index.js';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videothreads-db-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'videothreads.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePost(overrides: Partial<NormalizedThreadsPost> = {}): NormalizedThreadsPost {
  const now = 1764176400;
  return {
    id: 'post_01',
    shortcode: 'C8AbCdEf123',
    sourceUrl: 'https://www.threads.net/@uyentich19/post/C8AbCdEf123',
    authorHandle: 'uyentich19',
    authorDisplayName: 'Uyen Tich',
    isVerified: true,
    authorAvatarPath: '/tmp/videothreads/avatar.webp',
    postedDisplayDate: '11/02',
    rawText: 'Nội dung bài viết công sở gây bão Threads hôm nay.',
    images: [
      {
        kind: 'image',
        src: '/tmp/videothreads/img1.webp',
        width: 1080,
        height: 1080,
        aspectRatio: 1,
      },
    ],
    strippedVideoCount: 1,
    metrics: { likes: 520, replies: 34, reposts: 12, shares: 9 },
    topReplies: [
      {
        id: 'cmt_01',
        authorHandle: 'user_b',
        isVerified: false,
        authorAvatarSrc: '/tmp/videothreads/b.webp',
        postedDateLabel: '1h',
        text: 'Quá chuẩn luôn bạn ơi!',
        likes: 120,
        strippedVideoCount: 0,
      },
    ],
    textLengthState: 'ST-LEN-01',
    mediaState: 'ST-MED-02',
    commentState: 'ST-COM-03',
    expiresAt: now + 21600,
    createdAt: now,
    ...overrides,
  };
}

function makeScript(postId: string): AIDirectorOutput {
  return {
    id: 'script_01',
    postId,
    modelName: 'gemini-2.5-flash',
    hookLines: ['Drama công sở đỉnh cao 🔥'],
    selectedCommentIds: ['cmt_01'],
    segments: [
      {
        segmentId: 'post_p1',
        kind: 'MAIN_POST',
        authorHandle: 'uyentich19',
        displayText: 'Nội dung bài viết công sở gây bão Threads hôm nay.',
        ttsText: 'Nội dung bài viết công sở gây bão Threads hôm nay.',
        imageIndexes: [0],
        audioCues: [],
        visualCues: [],
      },
    ],
    promptTokens: 1800,
    completionTokens: 600,
    estimatedCostUsd: 0.0005,
    createdAt: 1764176405,
  };
}

function makeJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: 'job_01',
    postId: 'post_01',
    scriptId: 'script_01',
    status: 'QUEUED',
    fps: 60,
    theme: 'dark',
    voiceId: DEFAULT_VOICE_ID,
    outputVideoPath: null,
    videoDurationSec: null,
    latencyBreakdownMs: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1764176410,
    completedAt: null,
    ...overrides,
  };
}

describe('SQLite WAL Database Layer (Migrations 001 & 002)', () => {
  it('enables WAL journal mode and foreign_keys=ON on disk database and runs idempotent migrations [1, 2]', () => {
    const dbPath = createTempDbPath();
    const db = openDatabase(dbPath);
    try {
      const pragmas = getDatabasePragmas(db);
      expect(pragmas.journalMode).toBe('wal');
      expect(pragmas.foreignKeys).toBe(true);

      const firstRun = runMigrations(db);
      expect(firstRun).toEqual([1, 2]);

      const secondRun = runMigrations(db);
      expect(secondRun).toEqual([]);

      // Verify scoring columns are removed from director_scripts
      const columns = db
        .prepare<[], { name: string }>('PRAGMA table_info(director_scripts)')
        .all()
        .map((c) => c.name);
      expect(columns).not.toContain('humor_score');
      expect(columns).not.toContain('viral_score');
      expect(columns).not.toContain('verdict');
    } finally {
      db.close();
    }
  });

  it('supports PostRepository upsert, shortcode conflict update, TTL cache lookup, and delete', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const repo = new PostRepository(db);

      const post = makePost();
      repo.upsert(post);

      const found = repo.findById('post_01');
      expect(found?.shortcode).toBe('C8AbCdEf123');
      expect(found?.strippedVideoCount).toBe(1);
      expect(found?.images).toHaveLength(1);

      expect(repo.findValidCacheByShortcode('C8AbCdEf123', post.createdAt + 100)).not.toBeNull();
      expect(repo.findValidCacheByShortcode('C8AbCdEf123', post.expiresAt + 1)).toBeNull();

      repo.upsert({ ...post, rawText: 'Updated text', metrics: { ...post.metrics, likes: 999 } });
      const updated = repo.findByShortcode('C8AbCdEf123');
      expect(updated?.rawText).toBe('Updated text');
      expect(updated?.metrics.likes).toBe(999);

      expect(repo.deleteById('post_01')).toBe(true);
      expect(repo.findById('post_01')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('supports no-scoring DirectorScriptRepository and enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const postRepo = new PostRepository(db);
      const scriptRepo = new DirectorScriptRepository(db);

      expect(() => scriptRepo.create(makeScript('missing_post'))).toThrow();

      postRepo.upsert(makePost());
      scriptRepo.create(makeScript('post_01'));

      const found = scriptRepo.findById('script_01');
      expect(found?.hookLines).toEqual(['Drama công sở đỉnh cao 🔥']);
      expect(scriptRepo.findLatestByPostId('post_01')?.id).toBe('script_01');
    } finally {
      db.close();
    }
  });

  it('supports MediaAssetRepository CRUD and active category filtering', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const repo = new MediaAssetRepository(db);

      repo.upsert({
        id: 'gameplay_mc_01',
        category: 'GAMEPLAY',
        filePath: '/var/lib/videothreads/gameplay/mc_01.mp4',
        durationSec: 120,
        tags: ['minecraft', 'parkour'],
        isActive: true,
      });
      repo.upsert({
        id: 'sfx_whoosh',
        category: 'SFX',
        filePath: '/var/lib/videothreads/sfx/whoosh.wav',
        durationSec: 0.4,
        tags: ['transition'],
        isActive: true,
      });

      expect(repo.findActiveByCategory('GAMEPLAY')).toHaveLength(1);
      expect(repo.setActive('gameplay_mc_01', false)).toBe(true);
      expect(repo.findActiveByCategory('GAMEPLAY')).toHaveLength(0);
      expect(repo.findById('sfx_whoosh')?.tags).toEqual(['transition']);
    } finally {
      db.close();
    }
  });

  it('supports RenderJobRepository full lifecycle (QUEUED -> DIRECTING -> RENDERING -> COMPLETED / FAILED)', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const postRepo = new PostRepository(db);
      const scriptRepo = new DirectorScriptRepository(db);
      const jobRepo = new RenderJobRepository(db);

      postRepo.upsert(makePost());
      scriptRepo.create(makeScript('post_01'));

      jobRepo.create(makeJob({ id: 'job_ok', postId: null, scriptId: null }));
      expect(jobRepo.listByStatus('QUEUED')).toHaveLength(1);

      expect(jobRepo.linkPostAndScript('job_ok', 'post_01', 'script_01')).toBe(true);
      expect(jobRepo.updateStatus('job_ok', 'DIRECTING')).toBe(true);
      expect(jobRepo.updateStatus('job_ok', 'RENDERING')).toBe(true);
      expect(
        jobRepo.markCompleted('job_ok', {
          outputVideoPath: '/var/lib/videothreads/out/job_ok.mp4',
          videoDurationSec: 59.5,
          latencyBreakdownMs: { scrape: 1500, ai: 2100, tts: 7200, render: 18500, total: 29300 },
          completedAt: 1764176438,
        }),
      ).toBe(true);

      const completed = jobRepo.findById('job_ok');
      expect(completed?.status).toBe('COMPLETED');
      expect(completed?.voiceId).toBe('Adam bựa');
      expect(completed?.latencyBreakdownMs?.total).toBe(29300);

      jobRepo.create(makeJob({ id: 'job_failed', status: 'SCRAPING' }));
      expect(
        jobRepo.markFailed('job_failed', {
          errorCode: 'ERR_SCRAPER_TIMEOUT',
          errorMessage: 'Quá thời gian chờ phản hồi từ Threads (10s).',
        }),
      ).toBe(true);
      const failed = jobRepo.findById('job_failed');
      expect(failed?.status).toBe('FAILED');
      expect(failed?.errorCode).toBe('ERR_SCRAPER_TIMEOUT');
    } finally {
      db.close();
    }
  });
});
