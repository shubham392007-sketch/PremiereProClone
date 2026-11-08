import { describe, expect, it } from 'vitest';
import type { MediaAsset, Sequence } from '@/types';
import { createProject, createSequence, makeClip } from './factory';
import {
  activeClipsAt,
  addClip,
  addTrack,
  clipEnd,
  deleteClips,
  deleteTrack,
  duplicateClips,
  getAudioTracks,
  getVideoTracks,
  moveClips,
  reorderTrack,
  sequenceEndFrame,
  splitAllAtFrame,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from './operations';
import { MEDIA_COLORS } from '@/utils/presets';
import type { NewProjectConfig } from '@/types';

const CONFIG: NewProjectConfig = {
  name: 'Test Project',
  sequenceName: 'Sequence 01',
  width: 1920,
  height: 1080,
  frameRate: { num: 30, den: 1, label: '30' },
  audioSampleRate: 48000,
  colorSpace: 'Rec.709',
  previewQuality: 'full',
};

function makeSequence(): Sequence {
  return createSequence(CONFIG);
}

function addTestClip(sequence: Sequence, overrides: Partial<Parameters<typeof makeClip>[0]> = {}) {
  const track = getVideoTracks(sequence)[0];
  const clip = makeClip({
    mediaId: 'media-1',
    trackId: track.id,
    startFrame: 0,
    durationFrames: 90,
    color: MEDIA_COLORS.video,
    ...overrides,
  });
  addClip(sequence, clip);
  return clip;
}

describe('project/sequence factory', () => {
  it('creates a project with a configured sequence and default tracks', () => {
    const project = createProject(CONFIG);
    expect(project.schemaVersion).toBe(1);
    expect(project.sequences).toHaveLength(1);
    const sequence = project.sequences[0];
    expect(sequence.width).toBe(1920);
    expect(sequence.height).toBe(1080);
    expect(sequence.frameRate.num).toBe(30);
    expect(getVideoTracks(sequence)).toHaveLength(3);
    expect(getAudioTracks(sequence)).toHaveLength(3);
    expect(getVideoTracks(sequence).map((t) => t.name)).toEqual(['V1', 'V2', 'V3']);
    expect(getAudioTracks(sequence).map((t) => t.name)).toEqual(['A1', 'A2', 'A3']);
  });

  it('builds clips with integer frame timing and default properties', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 12, durationFrames: 45, sourceInFrame: 7 });
    expect(clip.startFrame).toBe(12);
    expect(clipEnd(clip)).toBe(57);
    expect(clip.sourceInFrame).toBe(7);
    expect(clip.transform.scale).toBe(1);
    expect(clip.audio.gain).toBe(1);
    expect(clip.enabled).toBe(true);
  });
});

describe('clip move and split', () => {
  it('moves clips by exact frames and clamps at sequence start', () => {
    const sequence = makeSequence();
    const a = addTestClip(sequence, { startFrame: 10, durationFrames: 30 });
    const b = addTestClip(sequence, { startFrame: 60, durationFrames: 30 });

    moveClips(sequence, [a.id, b.id], 15);
    expect(a.startFrame).toBe(25);
    expect(b.startFrame).toBe(75);

    moveClips(sequence, [a.id, b.id], -1000);
    expect(a.startFrame).toBe(0);
    expect(b.startFrame).toBe(50);
  });

  it('moves a single clip to a different track', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence);
    const v2 = getVideoTracks(sequence)[1];
    moveClips(sequence, [clip.id], 0, { targetTrackId: v2.id });
    expect(clip.trackId).toBe(v2.id);
  });

  it('splits a clip at an interior frame, preserving source timing', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 10, durationFrames: 100, sourceInFrame: 20 });
    const right = splitClip(sequence, clip.id, 50);
    expect(right).not.toBeNull();
    expect(clip.durationFrames).toBe(40);
    expect(clipEnd(clip)).toBe(50);
    expect(right!.startFrame).toBe(50);
    expect(right!.durationFrames).toBe(60);
    expect(right!.sourceInFrame).toBe(60);
    expect(sequence.clips).toHaveLength(2);
  });

  it('does not split outside clip boundaries', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 10, durationFrames: 20 });
    expect(splitClip(sequence, clip.id, 10)).toBeNull();
    expect(splitClip(sequence, clip.id, 30)).toBeNull();
    expect(splitClip(sequence, clip.id, 5)).toBeNull();
  });

  it('razors all clips crossing a frame', () => {
    const sequence = makeSequence();
    const a = addTestClip(sequence, { startFrame: 0, durationFrames: 100 });
    const b = addTestClip(sequence, { startFrame: 50, durationFrames: 100, trackId: getVideoTracks(sequence)[1].id });
    const created = splitAllAtFrame(sequence, 60);
    expect(created).toHaveLength(2);
    expect(clipEnd(a)).toBe(60);
    expect(clipEnd(b)).toBe(60);
  });
});

describe('trimming', () => {
  it('trims clip start inward and advances source in point', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 100, durationFrames: 100, sourceInFrame: 30 });
    trimClipStart(sequence, clip.id, 130);
    expect(clip.startFrame).toBe(130);
    expect(clip.durationFrames).toBe(70);
    expect(clip.sourceInFrame).toBe(60);
  });

  it('clamps start trim to available source media', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 100, durationFrames: 100, sourceInFrame: 30 });
    trimClipStart(sequence, clip.id, 20);
    // cannot extend further than sourceInFrame=30 frames before original start
    expect(clip.startFrame).toBe(70);
    expect(clip.sourceInFrame).toBe(0);
    expect(clip.durationFrames).toBe(130);
  });

  it('allows stills to extend freely (freeze frame)', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 100, durationFrames: 100, sourceInFrame: 0 });
    trimClipStart(sequence, clip.id, 0, { allowSourcePreRoll: true });
    expect(clip.startFrame).toBe(0);
    expect(clip.durationFrames).toBe(200);
    expect(clip.sourceInFrame).toBe(0);
  });

  it('trims clip end and respects maximum source duration', () => {
    const sequence = makeSequence();
    const clip = addTestClip(sequence, { startFrame: 10, durationFrames: 100 });
    trimClipEnd(sequence, clip.id, 60);
    expect(clip.durationFrames).toBe(50);
    trimClipEnd(sequence, clip.id, 9999, { maxEndFrame: 200 });
    expect(clipEnd(clip)).toBe(200);
    trimClipEnd(sequence, clip.id, 0);
    expect(clip.durationFrames).toBe(1);
  });
});

describe('delete/duplicate', () => {
  it('deletes clips and clears dangling link references', () => {
    const sequence = makeSequence();
    const a = addTestClip(sequence);
    const b = addTestClip(sequence, { startFrame: 200 });
    a.linkedClipId = b.id;
    b.linkedClipId = a.id;
    deleteClips(sequence, [a.id]);
    expect(sequence.clips).toHaveLength(1);
    expect(sequence.clips[0].linkedClipId).toBeNull();
  });

  it('duplicates clips with new ids and maintained internal links', () => {
    const sequence = makeSequence();
    const a = addTestClip(sequence);
    const b = addTestClip(sequence, { startFrame: 200 });
    a.linkedClipId = b.id;
    b.linkedClipId = a.id;
    const copies = duplicateClips(sequence, [a.id, b.id], 10);
    expect(copies).toHaveLength(2);
    const copiedA = sequence.clips.find((c) => c.id === copies[0])!;
    const copiedB = sequence.clips.find((c) => c.id === copies[1])!;
    expect(copiedA.startFrame).toBe(10);
    expect(copiedA.linkedClipId).toBe(copiedB.id);
    expect(copiedB.linkedClipId).toBe(copiedA.id);
    expect(sequence.clips).toHaveLength(4);
  });
});

describe('tracks', () => {
  it('adds video and audio tracks with sequential names', () => {
    const sequence = makeSequence();
    const v = addTrack(sequence, 'video');
    const a = addTrack(sequence, 'audio');
    expect(v.name).toBe('V4');
    expect(a.name).toBe('A4');
    expect(getVideoTracks(sequence)).toHaveLength(4);
  });

  it('refuses to delete non-empty tracks and deletes empty tracks', () => {
    const sequence = makeSequence();
    const v1 = getVideoTracks(sequence)[0];
    const v2 = getVideoTracks(sequence)[1];
    addTestClip(sequence, { trackId: v1.id });
    const nonEmpty = deleteTrack(sequence, v1.id);
    expect(nonEmpty.ok).toBe(false);
    const empty = deleteTrack(sequence, v2.id);
    expect(empty.ok).toBe(true);
    expect(getVideoTracks(sequence)).toHaveLength(2);
    expect(getVideoTracks(sequence).map((t) => t.name)).toEqual(['V1', 'V2']);
  });

  it('reorders tracks within their kind', () => {
    const sequence = makeSequence();
    const v1 = getVideoTracks(sequence)[0];
    const v2 = getVideoTracks(sequence)[1];
    expect(reorderTrack(sequence, v1.id, 1)).toBe(true);
    expect(getVideoTracks(sequence)[0].id).toBe(v2.id);
    expect(getVideoTracks(sequence)[1].id).toBe(v1.id);
  });
});

describe('queries', () => {
  it('reports active clips per track kind and sequence end', () => {
    const sequence = makeSequence();
    const v1 = addTestClip(sequence, { startFrame: 0, durationFrames: 30 });
    addTestClip(sequence, {
      startFrame: 10,
      durationFrames: 30,
      trackId: getVideoTracks(sequence)[1].id,
    });
    expect(activeClipsAt(sequence, 15, 'video')).toHaveLength(2);
    expect(activeClipsAt(sequence, 35, 'video')).toHaveLength(1);
    expect(activeClipsAt(sequence, 45, 'video')).toHaveLength(0);
    expect(sequenceEndFrame(sequence)).toBe(40);
    expect(clipEnd(v1)).toBe(30);
  });
});
