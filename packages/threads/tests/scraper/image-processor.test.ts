import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageProcessor } from '../../src/scraper/index.js';

async function createTestPngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 42, g: 120, b: 220 },
    },
  })
    .png()
    .toBuffer();
}

describe('ImageProcessor (Sharp WebP 85%, max 1080px, NVMe cache, SSRF)', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vt-img-test-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('downloads, resizes >1080px images to WebP 85%, caches on NVMe, and hits cache on repeat', async () => {
    const largePng = await createTestPngBuffer(2160, 1440);
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array(largePng), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const processor = new ImageProcessor({
      cacheDir,
      fetchFn,
      verifyDns: true,
      dnsLookupFn: () => Promise.resolve([{ address: '157.240.22.174', family: 4 }]),
    });

    const url = 'https://scontent.cdninstagram.com/v/t51.2885-15/large.png';
    const first = await processor.processImage(url, { subDir: 'job-1' });

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.fromCache).toBe(false);
    expect(first.width).toBe(1080);
    expect(first.height).toBe(720);
    expect(first.aspectRatio).toBe(1.5);
    expect(first.localPath.endsWith('.webp')).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const outMeta = await sharp(first.localPath).metadata();
    expect(outMeta.format).toBe('webp');
    expect(outMeta.width).toBe(1080);

    // Second call must hit local NVMe cache without calling fetch again
    const second = await processor.processImage(url, { subDir: 'job-1' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.fromCache).toBe(true);
    expect(second.localPath).toBe(first.localPath);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not enlarge images smaller than 1080px', async () => {
    const smallPng = await createTestPngBuffer(600, 600);
    const processor = new ImageProcessor({
      cacheDir,
      fetchFn: () =>
        Promise.resolve(
          new Response(new Uint8Array(smallPng), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
      verifyDns: false,
    });

    const res = await processor.processImage('https://scontent.fbcdn.net/small.png');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.width).toBe(600);
    expect(res.height).toBe(600);
  });

  it('retries transient HTTP 500 errors up to maxRetries=2 and succeeds on 3rd attempt', async () => {
    const png = await createTestPngBuffer(800, 800);
    let attempts = 0;
    const fetchFn = vi.fn(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.resolve(new Response('Server error', { status: 500 }));
      }
      return Promise.resolve(
        new Response(new Uint8Array(png), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );
    });

    const processor = new ImageProcessor({
      cacheDir,
      maxRetries: 2,
      fetchFn,
      verifyDns: false,
    });

    const res = await processor.processImage('https://scontent.cdninstagram.com/retry.png');
    expect(res.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('returns imageFailed: true on 404, corrupt bytes, video content-type, redirect, or SSRF block', async () => {
    const processor404 = new ImageProcessor({
      cacheDir,
      fetchFn: () => Promise.resolve(new Response('Not Found', { status: 404 })),
      verifyDns: false,
    });
    const r404 = await processor404.processImage('https://scontent.cdninstagram.com/missing.jpg');
    expect(r404.ok).toBe(false);
    if (!r404.ok) {
      expect(r404.imageFailed).toBe(true);
      expect(r404.ssrfBlocked).toBe(false);
    }

    const processorCorrupt = new ImageProcessor({
      cacheDir,
      maxRetries: 0,
      fetchFn: () =>
        Promise.resolve(
          new Response('not-valid-image-bytes', {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
        ),
      verifyDns: false,
    });
    const rCorrupt = await processorCorrupt.processImage(
      'https://scontent.cdninstagram.com/corrupt.jpg',
    );
    expect(rCorrupt.ok).toBe(false);
    if (!rCorrupt.ok) {
      expect(rCorrupt.imageFailed).toBe(true);
    }

    const processorVideo = new ImageProcessor({
      cacheDir,
      fetchFn: () =>
        Promise.resolve(
          new Response('fake-mp4', {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          }),
        ),
      verifyDns: false,
    });
    const rVideo = await processorVideo.processImage('https://scontent.cdninstagram.com/clip.mp4');
    expect(rVideo.ok).toBe(false);
    if (!rVideo.ok) {
      expect(rVideo.reason).toContain('NO_VIDEO_POLICY');
    }

    const processorRedirect = new ImageProcessor({
      cacheDir,
      fetchFn: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
        ),
      verifyDns: false,
    });
    const rRedirect = await processorRedirect.processImage(
      'https://scontent.cdninstagram.com/redirect.jpg',
    );
    expect(rRedirect.ok).toBe(false);
    if (!rRedirect.ok) {
      expect(rRedirect.ssrfBlocked).toBe(true);
    }

    const rSsrf = await processor404.processImage('https://evil.attacker.com/steal.jpg');
    expect(rSsrf.ok).toBe(false);
    if (!rSsrf.ok) {
      expect(rSsrf.ssrfBlocked).toBe(true);
    }
  });
});
