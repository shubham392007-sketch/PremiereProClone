import { describe, expect, it } from 'vitest';
import type { FrameRate, MediaAsset } from '@/types';
import { sourceDurationFrames } from './useSourceTransport';

const FPS_30: FrameRate = { num: 30, den: 1, label: '30' };
const FPS_2997: FrameRate = { num: 30000, den: 1001, label: '29.97' };

function makeAsset(patch: Partial<MediaAsset>): MediaAsset {
  return {
    id: 'media_test',
    name: 'test',
    fileName: 'test.mp4',
    mimeType: 'video/mp4',
    kind: 'video',
    sizeBytes: 1024,
    durationSec: 0,
    width: 1920,
    height: 1080,
    fps: null,
    hasAudio: false,
    storageKey: 'idb:test.mp4',
    importedAt: 0,
    binId: null,
    ...patch,
  };
}

describe('sourceDurationFrames', () => {
  it('converts probe duration to sequence frames', () => {
    expect(sourceDurationFrames(makeAsset({ durationSec: 10.5 }), FPS_30)).toBe(315);
    expect(sourceDurationFrames(makeAsset({ durationSec: 2 }), FPS_2997)).toBe(60);
  });

  it('uses the default still length for images (5 seconds)', () => {
    const image = makeAsset({ kind: 'image', durationSec: 0, width: 800, height: 600 });
    expect(sourceDurationFrames(image, FPS_30)).toBe(150);
  });

  it('returns 0 for missing or zero-length media', () => {
    expect(sourceDurationFrames(undefined, FPS_30)).toBe(0);
    expect(sourceDurationFrames(makeAsset({ durationSec: 0 }), FPS_30)).toBe(0);
    expect(sourceDurationFrames(makeAsset({ durationSec: Number.NaN }), FPS_30)).toBe(0);
  });
});
