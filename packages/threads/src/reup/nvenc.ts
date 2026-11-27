import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveFfmpegBin } from '../audio/ffmpeg-mastering.js';
import type { NvencProbeResult } from './types.js';

const execFileAsync = promisify(execFile);

let cachedProbe: NvencProbeResult | null = null;

/**
 * Real 0.2s `h264_nvenc` probe matching OpenReup's `pipeline/render.py::probe_nvenc`.
 * Falls back cleanly to `libx264` when driver/hardware/binary does not support NVENC.
 */
export async function probeNvenc(options?: {
  ffmpegBin?: string;
  force?: boolean;
  timeoutMs?: number;
}): Promise<NvencProbeResult> {
  if (cachedProbe && !options?.force && !options?.ffmpegBin) {
    return cachedProbe;
  }

  const ffmpegBin = options?.ffmpegBin ?? resolveFfmpegBin();
  const timeoutMs = options?.timeoutMs ?? 8_000;

  try {
    await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:d=0.2',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'h264_nvenc',
        '-f',
        'null',
        '-',
      ],
      { timeout: timeoutMs },
    );
    const ok: NvencProbeResult = {
      available: true,
      encoder: 'h264_nvenc',
      reason: '',
    };
    if (!options?.ffmpegBin) cachedProbe = ok;
    return ok;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : error instanceof Error
          ? error.message
          : String(error);
    const errLower = stderr.toLowerCase();

    let reason = 'NVENC không khả dụng; tự động fallback sang CPU libx264.';
    if (
      errLower.includes('minimum required nvidia driver') ||
      errLower.includes('api version') ||
      errLower.includes('does not support the required nvenc')
    ) {
      reason = 'Driver NVIDIA hiện tại không khớp phiên bản NVENC yêu cầu; fallback sang libx264.';
    } else if (errLower.includes('unknown encoder') || errLower.includes("encoder 'h264_nvenc'")) {
      reason = 'FFmpeg hiện tại không hỗ trợ h264_nvenc; fallback sang libx264.';
    } else if (
      errLower.includes('cannot load libcuda') ||
      errLower.includes('no nvenc capable') ||
      errLower.includes('no capable devices')
    ) {
      reason = 'Không tìm thấy GPU hỗ trợ NVENC; fallback sang libx264.';
    }

    const fallback: NvencProbeResult = {
      available: false,
      encoder: 'libx264',
      reason,
    };
    if (!options?.ffmpegBin) cachedProbe = fallback;
    return fallback;
  }
}

export function resetNvencProbeCache(): void {
  cachedProbe = null;
}
