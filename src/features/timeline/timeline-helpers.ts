import type { FrameRate, MediaAsset, Sequence, TimelineClip, Track, TrackKind } from '@/types';
import { sequenceEndFrame } from '@/engine/timeline/operations';
import { programPlayback } from '@/engine/playback/registry';
import { usePlaybackStore } from '@/stores/playback-store';
import { chooseRulerInterval, frameToPixels, framesToWidth, pixelsToFrame } from '@/utils/timeline-geometry';
import { MAX_CONTENT_WIDTH } from './timeline-constants';

/* ------------------------------------------------------------------ */
/* track ordering / rows                                               */
/* ------------------------------------------------------------------ */

export interface TrackRow {
  track: Track;
  top: number;
  height: number;
}

/**
 * Visual stacking order: video tracks top-down (highest Vn first), then audio
 * tracks top-down (A1 first, matching a classic NLE layout).
 */
export function displayOrderTracks(sequence: Sequence): Track[] {
  const video = sequence.tracks.filter((track) => track.kind === 'video').sort((a, b) => b.index - a.index);
  const audio = sequence.tracks.filter((track) => track.kind === 'audio').sort((a, b) => a.index - b.index);
  return [...video, ...audio];
}

export function buildTrackRows(tracks: Track[], heightOverrides: Record<string, number>): TrackRow[] {
  const rows: TrackRow[] = [];
  let top = 0;
  for (const track of tracks) {
    const height = heightOverrides[track.id] ?? track.height;
    rows.push({ track, top, height });
    top += height;
  }
  return rows;
}

export function rowsTotalHeight(rows: TrackRow[]): number {
  if (!rows.length) return 0;
  const last = rows[rows.length - 1];
  return last.top + last.height;
}

export function trackRowAtContentY(rows: TrackRow[], contentY: number): TrackRow | null {
  for (const row of rows) {
    if (contentY >= row.top && contentY < row.top + row.height) return row;
  }
  return null;
}

export function groupClipsByTrack(sequence: Sequence): Map<string, TimelineClip[]> {
  const map = new Map<string, TimelineClip[]>();
  for (const clip of sequence.clips) {
    const list = map.get(clip.trackId);
    if (list) list.push(clip);
    else map.set(clip.trackId, [clip]);
  }
  for (const list of map.values()) list.sort((a, b) => a.startFrame - b.startFrame);
  return map;
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

export function computeContentWidth(
  sequence: Sequence | null,
  fps: FrameRate,
  pixelsPerSecond: number,
  viewportWidth: number,
): number {
  const endFrame = sequence ? sequenceEndFrame(sequence) : 0;
  const endPx = frameToPixels(endFrame, fps, pixelsPerSecond);
  const raw = Math.max(viewportWidth, Math.ceil(endPx + 320), 320);
  return Math.min(MAX_CONTENT_WIDTH, raw);
}

export function clipLeftPx(clip: TimelineClip, fps: FrameRate, pixelsPerSecond: number): number {
  return frameToPixels(clip.startFrame, fps, pixelsPerSecond);
}

export function clipWidthPx(clip: TimelineClip, fps: FrameRate, pixelsPerSecond: number, minimum = 3): number {
  return Math.max(minimum, framesToWidth(clip.durationFrames, fps, pixelsPerSecond));
}

export function frameAtContentX(contentX: number, fps: FrameRate, pixelsPerSecond: number): number {
  return Math.max(0, pixelsToFrame(contentX, fps, pixelsPerSecond));
}

/* ------------------------------------------------------------------ */
/* media helpers                                                       */
/* ------------------------------------------------------------------ */

export function sourceMaxFrames(asset: MediaAsset | undefined, fps: FrameRate): number {
  if (!asset || asset.kind === 'image') return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.round((asset.durationSec * fps.num) / fps.den));
}

export function mediaKindForTrack(trackKind: TrackKind, mediaKind: MediaAsset['kind'] | undefined): boolean {
  if (!mediaKind) return false;
  return trackKind === 'audio' ? mediaKind === 'audio' : mediaKind !== 'audio';
}

/* ------------------------------------------------------------------ */
/* playback                                                            */
/* ------------------------------------------------------------------ */

/**
 * Seek the program playhead. The playback engine is registered by the program
 * monitor; before it mounts we fall back to the shared playback store.
 */
export function seekPlayhead(frame: number): void {
  const safe = Math.max(0, Math.round(frame));
  if (programPlayback.isReady()) programPlayback.seek(safe);
  else usePlaybackStore.getState().setCurrentFrame(safe);
}

/* ------------------------------------------------------------------ */
/* snapping                                                            */
/* ------------------------------------------------------------------ */

/** Candidate frames a dragged edge can snap to. */
export function collectSnapFrames(
  sequence: Sequence | null,
  excludeClipIds?: Set<string>,
  includePlayhead = true,
): number[] {
  const frames = new Set<number>([0]);
  if (includePlayhead) frames.add(usePlaybackStore.getState().currentFrame);
  if (sequence) {
    for (const marker of sequence.markers) frames.add(marker.frame);
    for (const clip of sequence.clips) {
      if (excludeClipIds?.has(clip.id)) continue;
      frames.add(clip.startFrame);
      frames.add(clip.startFrame + clip.durationFrames);
    }
    frames.add(sequenceEndFrame(sequence));
  }
  return [...frames].sort((a, b) => a - b);
}

export interface SnapResult {
  /** frame offset to add to the proposed delta so the candidate lands on snapFrame */
  deltaFrames: number;
  snapFrame: number;
}

/**
 * Find the closest snap target (compared in pixels so the sticky distance is
 * constant across zoom levels).
 */
export function findSnap(
  candidateFrames: number[],
  snapFrames: number[],
  fps: FrameRate,
  pixelsPerSecond: number,
  thresholdPx: number,
): SnapResult | null {
  if (!snapFrames.length || !candidateFrames.length) return null;
  let best: SnapResult | null = null;
  let bestDistance = thresholdPx + 0.0001;
  for (const candidate of candidateFrames) {
    const candidatePx = frameToPixels(candidate, fps, pixelsPerSecond);
    for (const snapFrame of snapFrames) {
      const distance = Math.abs(frameToPixels(snapFrame, fps, pixelsPerSecond) - candidatePx);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { deltaFrames: Math.round(snapFrame - candidate), snapFrame };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* ruler                                                               */
/* ------------------------------------------------------------------ */

export interface RulerTick {
  frame: number;
  x: number;
  major: boolean;
}

/**
 * Adaptive ruler ticks. Uses the shared `chooseRulerInterval` helper for the
 * base tick spacing, then subdivides and promotes a label interval so labels
 * never collide. Only ticks inside the visible window are produced.
 */
export function computeRulerTicks(
  fps: FrameRate,
  pixelsPerSecond: number,
  scrollLeft: number,
  viewportWidth: number,
): RulerTick[] {
  const fpsValue = fps.num / fps.den;
  const base = chooseRulerInterval(pixelsPerSecond, fps);
  const basePx = (base.frames / fpsValue) * pixelsPerSecond;

  let subdivision = 1;
  for (const divisor of [10, 5, 4, 2]) {
    if (base.frames % divisor === 0 && basePx / divisor >= 9) {
      subdivision = divisor;
      break;
    }
  }
  const minorFrames = Math.max(1, Math.round(base.frames / subdivision));

  let labelFrames = base.frames;
  for (const multiplier of [1, 2, 5, 10, 15, 30]) {
    const candidate = base.frames * multiplier;
    if ((candidate / fpsValue) * pixelsPerSecond >= 84) {
      labelFrames = candidate;
      break;
    }
  }

  const firstFrame = Math.max(0, pixelsToFrame(Math.max(0, scrollLeft - 56), fps, pixelsPerSecond));
  const lastFrame = pixelsToFrame(scrollLeft + viewportWidth + 56, fps, pixelsPerSecond);
  const firstTick = Math.floor(firstFrame / minorFrames) * minorFrames;

  const ticks: RulerTick[] = [];
  for (let frame = firstTick; frame <= lastFrame; frame += minorFrames) {
    ticks.push({
      frame,
      x: frameToPixels(frame, fps, pixelsPerSecond),
      major: labelFrames > 0 && frame % labelFrames === 0,
    });
    if (ticks.length > 3000) break;
  }
  return ticks;
}

/* ------------------------------------------------------------------ */
/* track actions                                                       */
/* ------------------------------------------------------------------ */

export function tracksOfKind(sequence: Sequence, kind: TrackKind): Track[] {
  return sequence.tracks.filter((track) => track.kind === kind).sort((a, b) => a.index - b.index);
}

export function trackHasClips(sequence: Sequence, trackId: string): boolean {
  return sequence.clips.some((clip) => clip.trackId === trackId);
}

/** Find the track of `kind` at a given 0-based index, or undefined. */
export function trackAtIndex(sequence: Sequence, kind: TrackKind, index: number): Track | undefined {
  return tracksOfKind(sequence, kind).find((track) => track.index === index);
}
