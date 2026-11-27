import { describe, expect, it } from 'vitest';
import {
  ScraperError,
  assertSafeMediaCdnUrl,
  isPrivateOrReservedIp,
  validateThreadsUrl,
} from '../../src/scraper/index.js';

describe('SSRF Guard & URL Validator', () => {
  describe('validateThreadsUrl', () => {
    it('accepts canonical threads.net, threads.com, and /t/ short URLs', () => {
      const a = validateThreadsUrl('https://www.threads.net/@uyentich19/post/C8abcXYZ_1');
      expect(a.shortcode).toBe('C8abcXYZ_1');
      expect(a.authorHandle).toBe('uyentich19');
      expect(a.canonicalUrl).toBe('https://www.threads.net/@uyentich19/post/C8abcXYZ_1');

      const b = validateThreadsUrl('https://threads.com/@dev.user/post/D9xyz-2/');
      expect(b.shortcode).toBe('D9xyz-2');
      expect(b.canonicalUrl).toBe('https://www.threads.net/@dev.user/post/D9xyz-2');

      const c = validateThreadsUrl('https://www.threads.net/t/ShortCode123');
      expect(c.shortcode).toBe('ShortCode123');
      expect(c.canonicalUrl).toBe('https://www.threads.net/t/ShortCode123');
    });

    it('rejects invalid hosts, http protocol, credentials, and non-443 ports with ERR_INVALID_URL', () => {
      const invalidUrls = [
        'http://www.threads.net/@user/post/abc123',
        'https://www.tiktok.com/@user/video/123',
        'https://www.threads.net/@user',
        'https://user:pass@www.threads.net/@user/post/abc123',
        'https://www.threads.net:8443/@user/post/abc123',
        'https://127.0.0.1/@user/post/abc123',
        'not-a-url',
      ];

      for (const bad of invalidUrls) {
        try {
          validateThreadsUrl(bad);
          expect.fail(`Expected ERR_INVALID_URL for "${bad}"`);
        } catch (err) {
          expect(err).toBeInstanceOf(ScraperError);
          expect((err as ScraperError).code).toBe('ERR_INVALID_URL');
        }
      }
    });
  });

  describe('isPrivateOrReservedIp', () => {
    it('flags loopback, RFC1918, link-local metadata, and private IPv6 addresses', () => {
      const blocked = [
        '127.0.0.1',
        '127.255.255.254',
        '10.0.0.1',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.100',
        '169.254.169.254',
        '0.0.0.0',
        '100.64.0.1',
        '::1',
        '::',
        'fc00::1',
        'fd12:3456::1',
        'fe80::1',
        '::ffff:127.0.0.1',
        '::ffff:169.254.169.254',
      ];

      for (const ip of blocked) {
        expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be blocked`).toBe(true);
      }
    });

    it('allows public IPv4 and IPv6 addresses', () => {
      const publicIps = ['157.240.22.174', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'];
      for (const ip of publicIps) {
        expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be allowed`).toBe(false);
      }
    });
  });

  describe('assertSafeMediaCdnUrl', () => {
    it('allows whitelisted Meta CDN domains resolving to public IPs', async () => {
      const url = await assertSafeMediaCdnUrl(
        'https://scontent-hkg4-1.cdninstagram.com/v/t51.2885-15/photo.jpg',
        {
          verifyDns: true,
          dnsLookupFn: () => Promise.resolve([{ address: '157.240.22.174', family: 4 }]),
        },
      );
      expect(url.hostname).toBe('scontent-hkg4-1.cdninstagram.com');
    });

    it('blocks non-whitelisted hosts, HTTP, credentials, and DNS rebinding to private IPs', async () => {
      await expect(
        assertSafeMediaCdnUrl('https://evil.example.com/img.jpg', { verifyDns: false }),
      ).rejects.toThrow('SSRF_BLOCKED');

      await expect(
        assertSafeMediaCdnUrl('http://scontent.cdninstagram.com/img.jpg', { verifyDns: false }),
      ).rejects.toThrow('SSRF_BLOCKED');

      await expect(
        assertSafeMediaCdnUrl('https://169.254.169.254/latest/meta-data/', { verifyDns: false }),
      ).rejects.toThrow('SSRF_BLOCKED');

      await expect(
        assertSafeMediaCdnUrl('https://scontent.fbcdn.net/photo.jpg', {
          verifyDns: true,
          dnsLookupFn: () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]),
        }),
      ).rejects.toThrow('SSRF_BLOCKED');
    });
  });
});
