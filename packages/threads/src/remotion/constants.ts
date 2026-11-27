import type { Theme } from '../contracts/common.js';

export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1920;
export const DEFAULT_FPS = 60;

export const FONT_FAMILY =
  "'Noto Sans', 'Liberation Sans', 'DejaVu Sans', sans-serif, 'Noto Color Emoji'";

export const LAYOUT_CENTER = {
  cardWidth: 940,
  bannerMaxWidth: 940,
} as const;

export const SAFE_ZONES = {
  top: 140,
  bottom: 300,
  right: 120,
  left: 40,
} as const;

export const SPRING_PHYSICS = {
  damping: 14,
  stiffness: 120,
  mass: 0.8,
} as const;

export const THEME_COLORS = {
  dark: {
    canvas: {
      background: '#101010',
      scrim: 'rgba(0, 0, 0, 0.40)',
    },
    card: {
      background: '#181818',
      backgroundSubtle: '#242424',
      border: 'rgba(255, 255, 255, 0.12)',
      divider: 'rgba(255, 255, 255, 0.08)',
    },
    text: {
      primary: '#F3F5F7',
      secondary: '#A0A0A0',
      tertiary: '#777777',
      link: '#3897F0',
      highlight: '#FFD700',
    },
    icon: {
      default: '#F3F5F7',
      heart: '#FF3040',
      repost: '#00BA7C',
    },
    badge: {
      background: '#282828',
      text: '#B0B0B0',
    },
    progressBar: {
      track: 'rgba(255, 255, 255, 0.15)',
      fill: '#FFFFFF',
    },
  },
  light: {
    canvas: {
      background: '#F5F5F7',
      scrim: 'rgba(0, 0, 0, 0.25)',
    },
    card: {
      background: '#FFFFFF',
      backgroundSubtle: '#F0F2F5',
      border: 'rgba(0, 0, 0, 0.08)',
      divider: 'rgba(0, 0, 0, 0.06)',
    },
    text: {
      primary: '#000000',
      secondary: '#555555',
      tertiary: '#888888',
      link: '#0095F6',
      highlight: '#D97706',
    },
    icon: {
      default: '#000000',
      heart: '#FF3040',
      repost: '#00BA7C',
    },
    badge: {
      background: '#EFEFEF',
      text: '#555555',
    },
    progressBar: {
      track: 'rgba(0, 0, 0, 0.1)',
      fill: '#000000',
    },
  },
} as const;

export function getThemeColors(theme: Theme) {
  return THEME_COLORS[theme] ?? THEME_COLORS.dark;
}
