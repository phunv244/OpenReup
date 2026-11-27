import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  isAllowedMediaCdnUrl,
  parseThreadsUrl,
  type ParsedThreadsUrl,
} from '../contracts/index.js';
import { ScraperError } from './errors.js';

export type DnsLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface SsrfValidationOptions {
  /**
   * When true, resolves the hostname via DNS and verifies none of the resolved
   * IPs fall inside private, loopback, link-local, or cloud metadata ranges.
   * Defaults to true in production.
   */
  verifyDns?: boolean;
  dnsLookupFn?: DnsLookupFn;
  /**
   * Test-only escape hatch allowing localhost/127.0.0.1 HTTP mock servers.
   * Must remain false in production.
   */
  allowLocalTestHosts?: boolean;
}

const LOCAL_TEST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let acc = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return null;
    }
    acc = (acc << 8) | octet;
  }

  return acc >>> 0;
}

function isIpv4InCidr(ipUint: number, baseIp: string, prefixLen: number): boolean {
  const baseUint = ipv4ToUint32(baseIp);
  if (baseUint === null) {
    return false;
  }
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipUint & mask) === (baseUint & mask);
}

const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // Current network
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // Carrier-grade NAT
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-local & AWS/GCP metadata (169.254.169.254)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // Benchmark testing
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // Reserved
];

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(ip);

  if (version === 4) {
    const uint = ipv4ToUint32(ip);
    if (uint === null) {
      return true;
    }
    return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => isIpv4InCidr(uint, base, prefix));
  }

  if (version === 6) {
    if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
      return true;
    }
    // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice('::ffff:'.length);
      if (isIP(mapped) === 4) {
        return isPrivateOrReservedIp(mapped);
      }
      const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
      if (hexMatch && hexMatch[1] && hexMatch[2]) {
        const hi = parseInt(hexMatch[1], 16);
        const lo = parseInt(hexMatch[2], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrReservedIp(dotted);
      }
    }
    // Unique local addresses fc00::/7 (fc.. or fd..)
    if (ip.startsWith('fc') || ip.startsWith('fd')) {
      return true;
    }
    // Link-local fe80::/10 (fe80..febf)
    if (/^fe[89ab][0-9a-f]:/.test(ip)) {
      return true;
    }
    return false;
  }

  return false;
}

export function validateThreadsUrl(rawUrl: string): ParsedThreadsUrl {
  const trimmed = rawUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new ScraperError('ERR_INVALID_URL', { details: { rawUrl } });
  }

  // Reject embedded credentials or non-default ports
  if (parsedUrl.username || parsedUrl.password || (parsedUrl.port && parsedUrl.port !== '443')) {
    throw new ScraperError('ERR_INVALID_URL', { details: { rawUrl } });
  }

  const parsed = parseThreadsUrl(trimmed);
  if (!parsed) {
    throw new ScraperError('ERR_INVALID_URL', { details: { rawUrl } });
  }

  return parsed;
}

async function defaultDnsLookup(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
}

export async function assertSafeMediaCdnUrl(
  rawUrl: string,
  options?: SsrfValidationOptions,
): Promise<URL> {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`SSRF_BLOCKED: Malformed media URL "${rawUrl}"`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('SSRF_BLOCKED: Credentials in media URL are forbidden');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (options?.allowLocalTestHosts && LOCAL_TEST_HOSTS.has(hostname)) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`SSRF_BLOCKED: Unsupported protocol "${parsed.protocol}"`);
    }
    return parsed;
  }

  if (parsed.port && parsed.port !== '443') {
    throw new Error(`SSRF_BLOCKED: Non-standard port "${parsed.port}" is forbidden`);
  }

  if (isPrivateOrReservedIp(hostname)) {
    throw new Error(`SSRF_BLOCKED: Direct private/reserved IP "${hostname}" is forbidden`);
  }

  if (!isAllowedMediaCdnUrl(trimmed)) {
    throw new Error(`SSRF_BLOCKED: Host "${hostname}" is not in allowed CDN whitelist`);
  }

  const verifyDns = options?.verifyDns ?? true;
  if (verifyDns) {
    const lookupFn = options?.dnsLookupFn ?? defaultDnsLookup;
    const records = await lookupFn(hostname);
    if (records.length === 0) {
      throw new Error(`SSRF_BLOCKED: DNS resolution returned no addresses for "${hostname}"`);
    }
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        throw new Error(
          `SSRF_BLOCKED: Host "${hostname}" resolved to private/reserved IP "${record.address}"`,
        );
      }
    }
  }

  return parsed;
}
