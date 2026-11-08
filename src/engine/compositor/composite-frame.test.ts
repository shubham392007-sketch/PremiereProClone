import { describe, expect, it } from 'vitest';
import type { MediaAsset, Sequence, TimelineClip, Track } from '@/types';
import {
  compositeSequenceFrame,
  previewQualityDivisor,
  type CompositeFrameProvider,
  type CompositeSource,
} from './composite-frame';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  op: string;
  args: unknown[];
}

function createFakeContext(width: number, height: number) {
  const calls: RecordedCall[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const ctx = {
    canvas: { width, height },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: record('save'),
    restore: record('restore'),
    setTransform: record('setTransform'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    drawImage: record('drawImage'),
    translate: record('translate'),
    rotate: record('rotate'),
    scale: record('scale'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
  };
  return { context: ctx as unknown as CanvasRenderingContext2D, calls };
}

function makeAsset(id: string, patch: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name: `asset-${id}`,
    fileName: `${id}.mp4`,
    mimeType: 'video/mp4',
    kind: 'video',
    sizeBytes: 1000,
    durationSec: 10,
    width: 1920,
    height: 1080,
    fps: null,
    hasAudio: true,
    storageKey: `idb:${id}`,
    importedAt: 0,
    binId: null,
    ...patch,
  };
}

function makeTrack(index: number, patch: Partial<Track> = {}): Track {
  return {
    id: `v${index}`,
    kind: 'video',
    name: `V${index + 1}`,
    index,
    height: 62,
    locked: false,
    muted: false,
    hidden: false,
    solo: false,
    enabled: true,
    ...patch,
  };
}

function makeClip(id: string, trackId: string, patch: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id,
    mediaId: 'm1',
    trackId,
    startFrame: 0,
    durationFrames: 100,
    sourceInFrame: 0,
    playbackRate: 1,
    enabled: true,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    audio: { gain: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0 },
    color: '#33587f',
    linkedClipId: null,
    ...patch,
  };
}

function makeSequence(tracks: Track[], clips: TimelineClip[]): Sequence {
  return {
    id: 'seq',
    name: 'Sequence 01',
    width: 160,
    height: 90,
    frameRate: { num: 30, den: 1, label: '30' },
    audioSampleRate: 48000,
    colorSpace: 'sRGB',
    previewQuality: 'full',
    tracks,
    clips,
    markers: [],
  };
}

function makeProvider(
  media: Map<string, MediaAsset>,
  sources: Map<string, CompositeSource>,
  hasSource: (mediaId: string) => boolean = () => true,
): CompositeFrameProvider {
  return {
    getMediaAsset: (mediaId) => media.get(mediaId),
    hasMediaSource: (mediaId) => hasSource(mediaId),
    getFrameSource: (clip) => sources.get(clip.id) ?? null,
  };
}

function makeSource(label: string): CompositeSource {
  return { image: { label } as unknown as CanvasImageSource, width: 1920, height: 1080 };
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe('compositeSequenceFrame', () => {
  it('clears to black before drawing the sequence', () => {
    const { context, calls } = createFakeContext(160, 90);
    const report = compositeSequenceFrame(context, makeSequence([makeTrack(0)], []), 0, makeProvider(new Map(), new Map()));
    expect(report.drawnClips).toBe(0);
    expect(calls.some((call) => call.op === 'setTransform')).toBe(true);
    expect(calls.find((call) => call.op === 'fillRect')?.args).toEqual([0, 0, 160, 90]);
    expect(calls.find((call) => call.op === 'drawImage')).toBeUndefined();
  });

  it('draws V1 first and V2 above it (bottom → top order)', () => {
    const { context, calls } = createFakeContext(160, 90);
    const low = makeSource('low');
    const high = makeSource('high');
    const sequence = makeSequence(
      [makeTrack(0), makeTrack(1)],
      [makeClip('clip-low', 'v0'), makeClip('clip-high', 'v1')],
    );
    const media = new Map([['m1', makeAsset('m1')]]);
    const sources = new Map([
      ['clip-low', low],
      ['clip-high', high],
    ]);

    const report = compositeSequenceFrame(context, sequence, 10, makeProvider(media, sources));
    expect(report.drawnClips).toBe(2);
    expect(report.offlineClips).toHaveLength(0);

    const draws = calls.filter((call) => call.op === 'drawImage');
    expect(draws).toHaveLength(2);
    expect(draws[0].args[0]).toBe(low.image);
    expect(draws[1].args[0]).toBe(high.image);
  });

  it('skips disabled clips, hidden tracks, disabled tracks and empty gaps', () => {
    const { context, calls } = createFakeContext(160, 90);
    const sequence = makeSequence(
      [
        makeTrack(0, { hidden: true }),
        makeTrack(1, { enabled: false }),
        makeTrack(2),
        makeTrack(3),
      ],
      [
        makeClip('hidden-track-clip', 'v0'),
        makeClip('disabled-track-clip', 'v1'),
        makeClip('disabled-clip', 'v2', { enabled: false }),
        makeClip('future-clip', 'v3', { startFrame: 50 }),
      ],
    );
    const media = new Map([['m1', makeAsset('m1')]]);
    const sources = new Map(
      ['hidden-track-clip', 'disabled-track-clip', 'disabled-clip', 'future-clip'].map((id) => [id, makeSource(id)]),
    );

    const report = compositeSequenceFrame(context, sequence, 10, makeProvider(media, sources));
    expect(report.drawnClips).toBe(0);
    expect(calls.filter((call) => call.op === 'drawImage')).toHaveLength(0);
  });

  it('applies transforms relative to the preview divisor', () => {
    const { context, calls } = createFakeContext(80, 45); // sequence at 1/2 quality
    const source = makeSource('frame');
    const clip = makeClip('clip', 'v0', {
      transform: { x: 20, y: -10, scale: 0.5, rotation: 90, opacity: 0.8 },
    });
    const sequence = makeSequence([makeTrack(0)], [clip]);
    const media = new Map([['m1', makeAsset('m1')]]);
    const sources = new Map([['clip', source]]);

    compositeSequenceFrame(context, sequence, 0, makeProvider(media, sources), previewQualityDivisor('half'));

    const translate = calls.find((call) => call.op === 'translate');
    // 80/2 + 20/2 = 50, 45/2 + -10/2 = 17.5
    expect(translate?.args).toEqual([50, 17.5]);
    const rotate = calls.find((call) => call.op === 'rotate');
    expect(rotate?.args[0]).toBeCloseTo(Math.PI / 2);
    const scale = calls.find((call) => call.op === 'scale');
    expect(scale?.args).toEqual([0.5, 0.5]);
    expect(calls.some((call) => call.op === 'drawImage')).toBe(true);
  });

  it('reports and slates offline media without throwing', () => {
    const { context, calls } = createFakeContext(160, 90);
    const sequence = makeSequence([makeTrack(0)], [makeClip('clip', 'v0')]);
    const missingAsset = makeAsset('m1', { missing: true });

    const report = compositeSequenceFrame(
      context,
      sequence,
      0,
      makeProvider(new Map([['m1', missingAsset]]), new Map()),
    );

    expect(report.drawnClips).toBe(0);
    expect(report.offlineClips).toHaveLength(1);
    expect(report.offlineClips[0].name).toBe('asset-m1');
    const offlineText = calls.find(
      (call) => call.op === 'fillText' && call.args[0] === 'MEDIA OFFLINE',
    );
    expect(offlineText).toBeTruthy();
  });

  it('also treats media without a runtime object URL as offline', () => {
    const { context } = createFakeContext(160, 90);
    const sequence = makeSequence([makeTrack(0)], [makeClip('clip', 'v0')]);
    const report = compositeSequenceFrame(
      context,
      sequence,
      0,
      makeProvider(new Map([['m1', makeAsset('m1')]]), new Map(), () => false),
    );
    expect(report.offlineClips).toHaveLength(1);
  });

  it('counts clips whose decoder frame is not ready yet', () => {
    const { context, calls } = createFakeContext(160, 90);
    const sequence = makeSequence([makeTrack(0)], [makeClip('clip', 'v0')]);
    const media = new Map([['m1', makeAsset('m1')]]);
    const report = compositeSequenceFrame(context, sequence, 0, makeProvider(media, new Map()));
    expect(report.unreadyClips).toBe(1);
    expect(report.offlineClips).toHaveLength(0);
    expect(calls.filter((call) => call.op === 'drawImage')).toHaveLength(0);
  });

  it('handles a degenerate canvas without drawing', () => {
    const { context, calls } = createFakeContext(1, 1);
    const report = compositeSequenceFrame(
      context,
      makeSequence([makeTrack(0)], [makeClip('clip', 'v0')]),
      0,
      makeProvider(new Map([['m1', makeAsset('m1')]]), new Map([['clip', makeSource('x')]])),
    );
    expect(report.drawnClips).toBe(0);
    expect(calls.filter((call) => call.op === 'drawImage')).toHaveLength(0);
  });
});

describe('previewQualityDivisor', () => {
  it('maps quality presets to internal divisors', () => {
    expect(previewQualityDivisor('full')).toBe(1);
    expect(previewQualityDivisor('half')).toBe(2);
    expect(previewQualityDivisor('quarter')).toBe(4);
  });
});
