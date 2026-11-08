import type { AudioProperties, Sequence, TimelineClip, Track } from '@/types';
import { clipEnd } from '@/engine/timeline/operations';

/** Linear gain for a clip at a local frame offset (0 = clip start). */
export function clipGainAtLocalFrame(clip: TimelineClip, localFrame: number): number {
  const audio = clip.audio;
  if (audio.muted) return 0;
  const base = Math.max(0, Math.min(2, audio.gain));
  let gain = base;
  if (audio.fadeInFrames > 0 && localFrame < audio.fadeInFrames) {
    gain *= Math.max(0, localFrame / audio.fadeInFrames);
  }
  const toEnd = clip.durationFrames - localFrame;
  if (audio.fadeOutFrames > 0 && toEnd < audio.fadeOutFrames) {
    gain *= Math.max(0, toEnd / audio.fadeOutFrames);
  }
  return Math.max(0, gain);
}

/** Gain contributed by a track (mute / solo handled at sequence level). */
export function trackGain(track: Track): number {
  return track.muted || !track.enabled ? 0 : 1;
}

export function anyAudioTrackSoloed(sequence: Sequence): boolean {
  return sequence.tracks.some((t) => t.kind === 'audio' && t.solo);
}

export function effectiveTrackGain(sequence: Sequence, track: Track): number {
  if (track.muted || !track.enabled) return 0;
  if (anyAudioTrackSoloed(sequence)) return track.solo ? 1 : 0;
  return 1;
}

export function clipLocalFrame(clip: TimelineClip, timelineFrame: number): number {
  return timelineFrame - clip.startFrame;
}

export function isClipActive(clip: TimelineClip, timelineFrame: number): boolean {
  return timelineFrame >= clip.startFrame && timelineFrame < clipEnd(clip);
}

/** Clamp a seek time to the decodable source range for an element. */
export function clampMediaTime(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, time);
  return Math.min(duration - 0.001, Math.max(0, time));
}

/** Format a frame offset as m:ss.cc for compact export logs. */
export function framesToClock(frame: number, fpsNum: number, fpsDen: number): string {
  const seconds = (frame * fpsDen) / fpsNum;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function totalAudioSampleCount(durationFrames: number, fpsNum: number, fpsDen: number, sampleRate: number): number {
  const seconds = (durationFrames * fpsDen) / fpsNum;
  return Math.ceil(seconds * sampleRate);
}

/** Export helper: audio gain for a clip at an absolute timeline frame. */
export function clipGainAtTimelineFrame(clip: TimelineClip, timelineFrame: number): number {
  return clipGainAtLocalFrame(clip, timelineFrame - clip.startFrame);
}

export type { AudioProperties };
