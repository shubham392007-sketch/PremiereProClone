import { describe, expect, it } from 'vitest';
import { frameRateFromFps, mediaKindForFile, validateMediaFile } from '@/services/media-import';
import { computePeaksFromChannelData } from '@/services/thumbnail-service';

function fakeFile(name: string, size = 1024, type = ''): File {
  return { name, size, type, lastModified: 0 } as unknown as File;
}

describe('validateMediaFile', () => {
  it('accepts supported video, audio and image extensions regardless of case', () => {
    const cases: { name: string; kind: string }[] = [
      { name: 'clip.mp4', kind: 'video' },
      { name: 'CLIP.MOV', kind: 'video' },
      { name: 'b-roll.webm', kind: 'video' },
      { name: 'voice.wav', kind: 'audio' },
      { name: 'music.MP3', kind: 'audio' },
      { name: 'photo.JPEG', kind: 'image' },
      { name: 'still.avif', kind: 'image' },
    ];
    for (const testCase of cases) {
      const result = validateMediaFile(fakeFile(testCase.name));
      expect(result.ok, testCase.name).toBe(true);
      expect(result.kind, testCase.name).toBe(testCase.kind);
    }
  });

  it('rejects unsupported extensions with a clear reason', () => {
    const result = validateMediaFile(fakeFile('notes.txt', 10, 'text/plain'));
    expect(result.ok).toBe(false);
    expect(result.kind).toBeNull();
    expect(result.reason).toContain('Unsupported file type');
    expect(result.reason).toContain('MP4');
    expect(result.reason).toContain('WAV');
  });

  it('rejects empty files instead of importing them', () => {
    const result = validateMediaFile(fakeFile('empty.mp4', 0));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('classifies media kinds from the extension', () => {
    expect(mediaKindForFile(fakeFile('a.MP3'))).toBe('audio');
    expect(mediaKindForFile(fakeFile('a.mp4'))).toBe('video');
    expect(mediaKindForFile(fakeFile('a.png'))).toBe('image');
    expect(mediaKindForFile(fakeFile('a.pdf'))).toBeNull();
  });
});

describe('frameRateFromFps', () => {
  it('snaps measured rates to professional presets', () => {
    expect(frameRateFromFps(29.97)).toEqual({ num: 30000, den: 1001, label: '29.97' });
    expect(frameRateFromFps(29.9699)).toEqual({ num: 30000, den: 1001, label: '29.97' });
    expect(frameRateFromFps(24)).toEqual({ num: 24, den: 1, label: '24' });
    expect(frameRateFromFps(59.94)).toEqual({ num: 60000, den: 1001, label: '59.94' });
  });

  it('returns null for unusable measurements', () => {
    expect(frameRateFromFps(null)).toBeNull();
    expect(frameRateFromFps(undefined)).toBeNull();
    expect(frameRateFromFps(0)).toBeNull();
    expect(frameRateFromFps(Number.NaN)).toBeNull();
    expect(frameRateFromFps(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps measured non-preset rates as reduced rationals', () => {
    const fps = frameRateFromFps(47.952);
    expect(fps).not.toBeNull();
    expect(fps!.num / fps!.den).toBeCloseTo(47.952, 3);
  });
});

describe('computePeaksFromChannelData', () => {
  it('buckets samples and normalizes the loudest peak to 1', () => {
    const peaks = computePeaksFromChannelData([new Float32Array([0, 0.5, -1, 0.25])], 2);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeCloseTo(0.5, 5);
    expect(peaks[1]).toBeCloseTo(1, 5);
  });

  it('keeps one peak per sample when the sample count is below the cap', () => {
    const peaks = computePeaksFromChannelData([new Float32Array([0, 0.5, -1, 0.25])], 1600);
    expect(peaks).toHaveLength(4);
    expect(peaks[2]).toBeCloseTo(1, 5);
  });

  it('returns an empty array for empty channel data', () => {
    expect(computePeaksFromChannelData([], 100)).toEqual([]);
    expect(computePeaksFromChannelData([new Float32Array([])], 100)).toEqual([]);
  });
});
