import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  directVideoScript,
  initLocalDatabase,
  listAvailableVoices,
  normalizeVietnameseTtsText,
  parseAndValidateThreadsUrl,
  prefetchAndOptimizeImages,
  scrapeThreadsPost,
  validateCompositionProps,
} from '../../src/code-mode/index.js';
import type { NormalizedThreadsPost } from '../../src/contracts/index.js';

describe('Code Mode SDK (src/code-mode/)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vt-codemode-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parseAndValidateThreadsUrl returns standardized CodeModeResult for valid & invalid URLs', async () => {
    const ok = await parseAndValidateThreadsUrl({
      url: 'https://www.threads.net/@uyentich19/post/C8abcXYZ_1',
    });
    expect(ok.ok).toBe(true);
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.shortcode).toBe('C8abcXYZ_1');
      expect(ok.meta.traceId).toBeTruthy();
    }

    const bad = await parseAndValidateThreadsUrl({ url: 'https://tiktok.com/@x/video/1' });
    expect(bad.ok).toBe(false);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.code).toBe('ERR_INVALID_URL');
    }
  });

  it('initLocalDatabase initializes WAL SQLite and applies migrations [1, 2]', async () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const res = await initLocalDatabase({ dbPath });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.pragmas.journalMode).toBe('wal');
      expect(res.data.pragmas.foreignKeys).toBe(true);
      expect(res.data.appliedMigrations).toEqual([1, 2]);
    }
  });

  it('listAvailableVoices returns 25 VieNeu-TTS voices (default Adam bựa) + 2 Edge-TTS fallbacks', async () => {
    const all = await listAvailableVoices();
    expect(all.success).toBe(true);
    if (all.success) {
      expect(all.data.defaultVoiceId).toBe('Adam bựa');
      expect(all.data.vieneuCount).toBe(25);
      expect(all.data.edgeFallbackCount).toBe(2);
      expect(all.data.totalCount).toBe(27);
    }

    const vieneuFemale = await listAvailableVoices({ engine: 'vieneu', gender: 'female' });
    expect(vieneuFemale.success).toBe(true);
    if (vieneuFemale.success) {
      expect(vieneuFemale.data.totalCount).toBe(11);
      expect(vieneuFemale.data.voices.some((v) => v.id === 'Trúc Ly')).toBe(true);
    }
  });

  it('normalizeVietnameseTtsText & directVideoScript work cleanly via Code Mode envelope', async () => {
    const norm = await normalizeVietnameseTtsText({
      text: 'Lương 9tr2 ko trừ bhxh nhma vẫn phải OT :))',
    });
    expect(norm.success).toBe(true);
    if (norm.success) {
      expect(norm.data.ttsText).toContain('chín triệu hai');
      expect(norm.data.displayText).toContain('9tr2');
    }

    const samplePost: NormalizedThreadsPost = {
      id: 'post_cm_1',
      shortcode: 'CM_01',
      sourceUrl: 'https://www.threads.net/@dev_vn/post/CM_01',
      authorHandle: 'dev_vn',
      isVerified: false,
      authorAvatarPath: '.cache/images/shared/av.webp',
      postedDisplayDate: '1h',
      rawText: 'Sếp bắt tăng ca cuối tuần mà không trả lương OT mn thấy sao?',
      images: [],
      strippedVideoCount: 0,
      metrics: { likes: 500, replies: 0, reposts: 10, shares: 5 },
      topReplies: [],
      textLengthState: 'ST-LEN-01',
      mediaState: 'ST-MED-01',
      commentState: 'ST-COM-01',
      expiresAt: 1764200000,
      createdAt: 1764178400,
    };

    const directed = await directVideoScript({ post: samplePost });
    expect(directed.success).toBe(true);
    if (directed.success) {
      expect(directed.data.script.hookLines.length).toBeGreaterThanOrEqual(1);
      expect(directed.data.script.segments.some((s) => s.kind === 'CTA_OUTRO')).toBe(true);
    }
  });

  it('prefetchAndOptimizeImages optimizes batch into shared cache with concurrency <= 5', async () => {
    const png = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 200, b: 100 } },
    })
      .png()
      .toBuffer();

    const res = await prefetchAndOptimizeImages({
      items: [
        { url: 'https://scontent.cdninstagram.com/a.png' },
        { url: 'https://scontent.cdninstagram.com/b.png' },
      ],
      concurrency: 5,
      cacheDir: tmpDir,
      verifyDns: false,
      fetchFn: () =>
        Promise.resolve(
          new Response(new Uint8Array(png), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.succeededCount).toBe(2);
      expect(res.data.failedCount).toBe(0);
    }
  });

  it('scrapeThreadsPost & validateCompositionProps return structured failure envelopes instead of throwing', async () => {
    const badScrape = await scrapeThreadsPost({ url: 'https://invalid.example.com/123' });
    expect(badScrape.success).toBe(false);
    if (!badScrape.success) {
      expect(badScrape.error.code).toBe('ERR_INVALID_URL');
    }

    const badProps = await validateCompositionProps({ props: { invalid: true } });
    expect(badProps.success).toBe(false);
    if (!badProps.success) {
      expect(badProps.error.code).toBe('ERR_VALIDATION_FAILED');
    }
  });
});
