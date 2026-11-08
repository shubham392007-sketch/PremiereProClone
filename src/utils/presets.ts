import type { FrameRate, MediaAsset, MediaKind, PreviewQuality, ColorSpace } from '@/types';

/** Common professional frame-rate presets. */
export const FRAME_RATE_PRESETS: FrameRate[] = [
  { num: 24000, den: 1001, label: '23.976' },
  { num: 24, den: 1, label: '24' },
  { num: 25, den: 1, label: '25' },
  { num: 30000, den: 1001, label: '29.97' },
  { num: 30, den: 1, label: '30' },
  { num: 50, den: 1, label: '50' },
  { num: 60000, den: 1001, label: '59.94' },
  { num: 60, den: 1, label: '60' },
];

export interface ResolutionPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: '720p', label: 'HD 720p — 1280 × 720', width: 1280, height: 720 },
  { id: '1080p', label: 'Full HD 1080p — 1920 × 1080', width: 1920, height: 1080 },
  { id: '1440p', label: 'QHD 1440p — 2560 × 1440', width: 2560, height: 1440 },
  { id: '4k', label: 'UHD 4K — 3840 × 2160', width: 3840, height: 2160 },
];

export interface AspectPreset {
  id: string;
  label: string;
  ratio: number;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: '16:9', label: '16:9 Widescreen', ratio: 16 / 9 },
  { id: '9:16', label: '9:16 Vertical', ratio: 9 / 16 },
  { id: '1:1', label: '1:1 Square', ratio: 1 },
  { id: '4:3', label: '4:3 Standard', ratio: 4 / 3 },
];

export const AUDIO_SAMPLE_RATES = [44100, 48000, 96000];

export const COLOR_SPACES: ColorSpace[] = ['sRGB', 'Rec.709'];

export const PREVIEW_QUALITIES: { id: PreviewQuality; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'half', label: '1/2' },
  { id: 'quarter', label: '1/4' },
];

export const MEDIA_COLORS: Record<MediaKind, string> = {
  video: '#33587f',
  audio: '#2f6554',
  image: '#6b4b2c',
};

export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'];
export const SUPPORTED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus'];
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
export const SUPPORTED_MEDIA_EXTENSIONS = [
  ...SUPPORTED_VIDEO_EXTENSIONS,
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_IMAGE_EXTENSIONS,
];

export function kindForFile(file: File): MediaKind | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (SUPPORTED_VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) return 'image';
  // MIME fallback
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

export function mediaAssetDisplayDuration(asset: MediaAsset, fps: FrameRate): string {
  if (asset.kind === 'image') return 'Still';
  return formatDuration(asset.durationSec);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function aspectRatioLabel(width: number, height: number): string {
  if (!width || !height) return '—';
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}
