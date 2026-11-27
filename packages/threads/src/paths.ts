import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const THREADS_PKG_ROOT = path.resolve(THIS_DIR, '..');

export function resolveOpenReupRoot(): string {
  if (process.env['OPENREUP_ROOT']) {
    return path.resolve(process.env['OPENREUP_ROOT']);
  }
  const candidate = path.resolve(THREADS_PKG_ROOT, '..', '..');
  if (existsSync(path.join(candidate, 'server', 'app.mjs'))) {
    return candidate;
  }
  return process.cwd();
}

export function resolveThreadsAssetsDir(): string {
  return path.join(THREADS_PKG_ROOT, 'assets');
}

export function resolveOpenReupDataDir(): string {
  if (process.env['REUP_DATA_DIR']) {
    return path.resolve(process.env['REUP_DATA_DIR']);
  }
  return path.join(resolveOpenReupRoot(), 'data');
}

export function resolveOpenReupMediaRoot(): string {
  if (process.env['REUP_MEDIA_ROOT']) {
    return path.resolve(process.env['REUP_MEDIA_ROOT']);
  }
  return resolveOpenReupRoot();
}

export function resolveThreadsDownloadsDir(): string {
  return path.join(resolveOpenReupMediaRoot(), 'downloads', 'threads');
}

export function resolveThreadsWorkDir(jobId?: string): string {
  const base = path.join(resolveOpenReupDataDir(), 'threads_work');
  return jobId ? path.join(base, jobId) : base;
}

export function resolveThreadsCacheDir(): string {
  if (process.env['VIDEOTHREADS_CACHE_DIR']) {
    return path.resolve(process.env['VIDEOTHREADS_CACHE_DIR']);
  }
  return path.join(resolveOpenReupDataDir(), 'threads_cache');
}

export function resolveRemotionEntryPoint(): string {
  return path.resolve(THREADS_PKG_ROOT, 'src', 'remotion', 'index.ts');
}

export function resolveRemotionPublicDir(): string {
  return resolveOpenReupRoot();
}

export function resolveOpenReupFontsDir(): string {
  if (process.env['OPENREUP_FONTS_DIR']) {
    return path.resolve(process.env['OPENREUP_FONTS_DIR']);
  }
  return path.join(resolveOpenReupDataDir(), 'fonts');
}

export function resolveOpenReupPythonBin(): string {
  const override = process.env['REUP_PYTHON'] || process.env['VIENEU_PYTHON_BIN'];
  if (override) return override;
  const venvPy = path.join(resolveOpenReupRoot(), '.venv', 'bin', 'python');
  if (existsSync(venvPy)) return venvPy;
  const venvPy3 = path.join(resolveOpenReupRoot(), '.venv', 'bin', 'python3');
  if (existsSync(venvPy3)) return venvPy3;
  return 'python3';
}

export function resolveLocalBinary(name: 'ffmpeg' | 'ffprobe', envKeys: readonly string[]): string {
  for (const key of envKeys) {
    const val = process.env[key]?.trim();
    if (val) return val;
  }
  const openReupLocal = path.join(resolveOpenReupRoot(), '.local', 'bin', name);
  if (existsSync(openReupLocal)) return openReupLocal;
  const homeLocal = path.join(os.homedir(), '.local', 'bin', name);
  if (existsSync(homeLocal)) return homeLocal;
  return name;
}
