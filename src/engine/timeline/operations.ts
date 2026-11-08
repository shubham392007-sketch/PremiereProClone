import type { Marker, Sequence, TimelineClip, Track, TrackKind } from '@/types';
import { createId } from '@/utils/id';
import { clamp } from '@/utils/time';
import { makeAudioTrack, makeVideoTrack } from './factory';

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

export function getClip(sequence: Sequence, clipId: string): TimelineClip | undefined {
  return sequence.clips.find((c) => c.id === clipId);
}

export function clipEnd(clip: TimelineClip): number {
  return clip.startFrame + clip.durationFrames;
}

export function getTrack(sequence: Sequence, trackId: string): Track | undefined {
  return sequence.tracks.find((t) => t.id === trackId);
}

/** Video tracks ordered bottom (V1) to top. */
export function getVideoTracks(sequence: Sequence): Track[] {
  return sequence.tracks.filter((t) => t.kind === 'video').sort((a, b) => a.index - b.index);
}

/** Audio tracks ordered A1 upward. */
export function getAudioTracks(sequence: Sequence): Track[] {
  return sequence.tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.index - b.index);
}

export function tracksOfKind(sequence: Sequence, kind: TrackKind): Track[] {
  return kind === 'video' ? getVideoTracks(sequence) : getAudioTracks(sequence);
}

export function clipsOnTrack(sequence: Sequence, trackId: string): TimelineClip[] {
  return sequence.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame);
}

export function clipAtFrame(sequence: Sequence, trackId: string, frame: number): TimelineClip | undefined {
  return sequence.clips
    .filter((c) => c.trackId === trackId && frame >= c.startFrame && frame < clipEnd(c))
    .sort((a, b) => b.startFrame - a.startFrame)[0];
}

/** Clips visible on a given frame on any track of the kind, ordered bottom -> top. */
export function activeClipsAt(sequence: Sequence, frame: number, kind: TrackKind): { track: Track; clip: TimelineClip }[] {
  const tracks = tracksOfKind(sequence, kind);
  const result: { track: Track; clip: TimelineClip }[] = [];
  for (const track of tracks) {
    const clip = clipAtFrame(sequence, track.id, frame);
    if (clip && clip.enabled && track.enabled) result.push({ track, clip });
  }
  return result;
}

/** All timeline boundary frames, useful for snapping and tests. */
export function clipBoundaries(sequence: Sequence): number[] {
  const set = new Set<number>([0]);
  for (const clip of sequence.clips) {
    set.add(clip.startFrame);
    set.add(clipEnd(clip));
  }
  return [...set].sort((a, b) => a - b);
}

export function sequenceEndFrame(sequence: Sequence): number {
  let end = 0;
  for (const clip of sequence.clips) end = Math.max(end, clipEnd(clip));
  for (const m of sequence.markers) end = Math.max(end, m.frame);
  return end;
}

/* ------------------------------------------------------------------ */
/* clip mutations (operate on the passed draft)                        */
/* ------------------------------------------------------------------ */

export function addClip(sequence: Sequence, clip: TimelineClip): TimelineClip {
  sequence.clips.push(clip);
  return clip;
}

export function setClip(sequence: Sequence, clipId: string, patch: Partial<TimelineClip>): boolean {
  const clip = getClip(sequence, clipId);
  if (!clip) return false;
  Object.assign(clip, patch);
  if (clip.startFrame < 0) clip.startFrame = 0;
  if (clip.durationFrames < 1) clip.durationFrames = 1;
  if (clip.sourceInFrame < 0) clip.sourceInFrame = 0;
  return true;
}

/**
 * Move clips by a whole-frame delta. When targetTrackId is supplied the first
 * clip moves to that track (used for vertical drags of a single clip).
 */
export function moveClips(
  sequence: Sequence,
  clipIds: string[],
  deltaFrames: number,
  opts: { targetTrackId?: string } = {},
): void {
  const clips = clipIds.map((id) => getClip(sequence, id)).filter(Boolean) as TimelineClip[];
  if (!clips.length) return;
  const minStart = Math.min(...clips.map((c) => c.startFrame));
  const safeDelta = Math.max(deltaFrames, -minStart);
  clips.forEach((clip, i) => {
    clip.startFrame += safeDelta;
    if (opts.targetTrackId && i === 0) clip.trackId = opts.targetTrackId;
  });
}

/**
 * Trim the in-point of a clip so it starts at `desiredStartFrame`.
 * Default behaviour clamps to available source media (no freeze frame). Stills
 * pass allowSourcePreRoll to extend freely.
 */
export function trimClipStart(
  sequence: Sequence,
  clipId: string,
  desiredStartFrame: number,
  opts: { allowSourcePreRoll?: boolean } = {},
): boolean {
  const clip = getClip(sequence, clipId);
  if (!clip) return false;
  const end = clipEnd(clip);
  let newStart = clamp(Math.round(desiredStartFrame), 0, end - 1);
  const delta = newStart - clip.startFrame;
  let newSourceIn = clip.sourceInFrame + delta * clip.playbackRate;
  if (!opts.allowSourcePreRoll && newSourceIn < 0) {
    newStart = clip.startFrame - Math.floor(clip.sourceInFrame / clip.playbackRate);
    newStart = Math.max(0, newStart);
    newSourceIn = 0;
  } else if (opts.allowSourcePreRoll && newSourceIn < 0) {
    newSourceIn = 0;
  }
  if (newStart >= end) return false;
  clip.startFrame = newStart;
  clip.sourceInFrame = Math.max(0, Math.round(newSourceIn));
  clip.durationFrames = end - newStart;
  return true;
}

/**
 * Trim the out-point so the clip ends at `desiredEndFrame`.
 * `maxEndFrame` limits extension to available source media.
 */
export function trimClipEnd(
  sequence: Sequence,
  clipId: string,
  desiredEndFrame: number,
  opts: { maxEndFrame?: number } = {},
): boolean {
  const clip = getClip(sequence, clipId);
  if (!clip) return false;
  const minEnd = clip.startFrame + 1;
  const maxEnd = Math.max(minEnd, opts.maxEndFrame ?? Number.MAX_SAFE_INTEGER);
  const newEnd = clamp(Math.round(desiredEndFrame), minEnd, maxEnd);
  clip.durationFrames = newEnd - clip.startFrame;
  return true;
}

/** Split a clip at an interior frame. Returns the new right-hand clip. */
export function splitClip(sequence: Sequence, clipId: string, frame: number): TimelineClip | null {
  const clip = getClip(sequence, clipId);
  if (!clip) return null;
  const at = Math.round(frame);
  if (at <= clip.startFrame || at >= clipEnd(clip)) return null;
  const offset = at - clip.startFrame;
  const right: TimelineClip = {
    ...structuredClone(clip),
    id: createId('clip'),
    startFrame: at,
    durationFrames: clip.durationFrames - offset,
    sourceInFrame: Math.max(0, clip.sourceInFrame + Math.round(offset * clip.playbackRate)),
    linkedClipId: null,
  };
  clip.durationFrames = offset;
  sequence.clips.push(right);
  return right;
}

/** Razor every clip crossing the frame. Returns ids of newly created right clips. */
export function splitAllAtFrame(sequence: Sequence, frame: number): string[] {
  const targets = sequence.clips.filter(
    (c) => frame > c.startFrame && frame < clipEnd(c),
  );
  const created: string[] = [];
  for (const clip of targets) {
    const right = splitClip(sequence, clip.id, frame);
    if (right) created.push(right.id);
  }
  return created;
}

export function deleteClips(sequence: Sequence, clipIds: string[]): void {
  const ids = new Set(clipIds);
  sequence.clips = sequence.clips.filter((c) => !ids.has(c.id));
  for (const clip of sequence.clips) {
    if (clip.linkedClipId && ids.has(clip.linkedClipId)) clip.linkedClipId = null;
  }
}

/** Duplicate clips, offsetting each copy in time. Returns the new clip ids. */
export function duplicateClips(sequence: Sequence, clipIds: string[], offsetFrames = 0): string[] {
  const originals = clipIds
    .map((id) => getClip(sequence, id))
    .filter(Boolean) as TimelineClip[];
  if (!originals.length) return [];
  const idMap = new Map<string, string>();
  const copies: TimelineClip[] = originals.map((clip) => {
    const copy: TimelineClip = {
      ...structuredClone(clip),
      id: createId('clip'),
      startFrame: Math.max(0, clip.startFrame + offsetFrames),
      linkedClipId: null,
    };
    idMap.set(clip.id, copy.id);
    return copy;
  });
  // Preserve internal linkage between duplicated pairs.
  copies.forEach((copy, i) => {
    const originalLinked = originals[i].linkedClipId;
    if (originalLinked && idMap.has(originalLinked)) copy.linkedClipId = idMap.get(originalLinked)!;
  });
  sequence.clips.push(...copies);
  return copies.map((c) => c.id);
}

export function setClipsEnabled(sequence: Sequence, clipIds: string[], enabled: boolean): void {
  const ids = new Set(clipIds);
  for (const clip of sequence.clips) if (ids.has(clip.id)) clip.enabled = enabled;
}

/* ------------------------------------------------------------------ */
/* track mutations                                                     */
/* ------------------------------------------------------------------ */

export function addTrack(sequence: Sequence, kind: TrackKind): Track {
  const existing = tracksOfKind(sequence, kind);
  const index = existing.length ? Math.max(...existing.map((t) => t.index)) + 1 : 0;
  const track = kind === 'video' ? makeVideoTrack(index) : makeAudioTrack(index);
  sequence.tracks.push(track);
  return track;
}

export interface DeleteTrackResult {
  ok: boolean;
  reason?: string;
}

export function deleteTrack(sequence: Sequence, trackId: string): DeleteTrackResult {
  const track = getTrack(sequence, trackId);
  if (!track) return { ok: false, reason: 'Track not found' };
  if (sequence.clips.some((c) => c.trackId === trackId)) {
    return { ok: false, reason: 'Track is not empty' };
  }
  const sameKind = tracksOfKind(sequence, track.kind);
  if (sameKind.length <= 1) {
    return { ok: false, reason: `A sequence needs at least one ${track.kind} track` };
  }
  sequence.tracks = sequence.tracks.filter((t) => t.id !== trackId);
  // reindex remaining tracks of that kind
  tracksOfKind(sequence, track.kind).forEach((t, i) => {
    t.index = i;
    t.name = `${track.kind === 'video' ? 'V' : 'A'}${i + 1}`;
  });
  return { ok: true };
}

export function updateTrack(sequence: Sequence, trackId: string, patch: Partial<Track>): boolean {
  const track = getTrack(sequence, trackId);
  if (!track) return false;
  Object.assign(track, patch);
  return true;
}

/** Move a track one slot up/down within its kind (0-based array of that kind). */
export function reorderTrack(sequence: Sequence, trackId: string, direction: -1 | 1): boolean {
  const track = getTrack(sequence, trackId);
  if (!track) return false;
  const peers = tracksOfKind(sequence, track.kind);
  const pos = peers.indexOf(track);
  const target = pos + direction;
  if (pos < 0 || target < 0 || target >= peers.length) return false;
  [peers[pos], peers[target]] = [peers[target], peers[pos]];
  peers.forEach((t, i) => {
    t.index = i;
    t.name = `${track.kind === 'video' ? 'V' : 'A'}${i + 1}`;
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* markers                                                             */
/* ------------------------------------------------------------------ */

export function addMarker(sequence: Sequence, frame: number, name = 'Marker', color = '#d9a33a'): Marker {
  const marker: Marker = {
    id: createId('marker'),
    frame: Math.max(0, Math.round(frame)),
    name,
    color,
  };
  sequence.markers.push(marker);
  sequence.markers.sort((a, b) => a.frame - b.frame);
  return marker;
}

export function removeMarker(sequence: Sequence, markerId: string): void {
  sequence.markers = sequence.markers.filter((m) => m.id !== markerId);
}

/** Move a boundary while keeping linked clips in sync (used by drag/trim). */
export function linkedClipIds(sequence: Sequence, clipId: string): string[] {
  const clip = getClip(sequence, clipId);
  if (!clip) return [clipId];
  const ids = [clipId];
  if (clip.linkedClipId) ids.push(clip.linkedClipId);
  for (const c of sequence.clips) {
    if (c.linkedClipId === clipId && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}
