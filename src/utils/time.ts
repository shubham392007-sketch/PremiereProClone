import type { FrameRate, Sequence } from '@/types';

/** frames per second as a float (only for display/conversion at the edges). */
export function fpsOf(fps: FrameRate): number {
  return fps.num / fps.den;
}

export function frameToSeconds(frame: number, fps: FrameRate): number {
  return (frame * fps.den) / fps.num;
}

export function secondsToFrame(seconds: number, fps: FrameRate): number {
  return Math.round((seconds * fps.num) / fps.den);
}

export function secondsToFrameFloor(seconds: number, fps: FrameRate): number {
  return Math.floor((seconds * fps.num) / fps.den);
}

/** duration of one frame in milliseconds */
export function frameDurationMs(fps: FrameRate): number {
  return (1000 * fps.den) / fps.num;
}

/** nominal integer rate used for timecode counting (24, 25, 30, 50, 60...) */
export function nominalFps(fps: FrameRate): number {
  return Math.round(fps.num / fps.den);
}

export function isDropFrame(fps: FrameRate): boolean {
  return fps.den === 1001 && (fps.num === 30000 || fps.num === 60000);
}

/**
 * SMPTE timecode. Uses drop-frame counting for 29.97/59.94 with `;` separator,
 * non-drop otherwise.
 */
export function frameToTimecode(frame: number, fps: FrameRate): string {
  const nominal = nominalFps(fps);
  const safeFrame = Math.max(0, Math.round(frame));

  if (!isDropFrame(fps)) {
    const f = safeFrame % nominal;
    const totalSeconds = Math.floor(safeFrame / nominal);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`;
  }

  const dropFrames = Math.round(fpsOf(fps) * 0.066666); // 2 @ 29.97, 4 @ 59.94
  const framesPerMinute = nominal * 60 - dropFrames;
  const framesPer10Minutes = Math.round(fpsOf(fps) * 600);
  const framesPerHour = Math.round(fpsOf(fps) * 3600);
  let f = safeFrame % (framesPerHour * 24);
  const tenMinChunks = Math.floor(f / framesPer10Minutes);
  const remainder = f % framesPer10Minutes;
  if (remainder > dropFrames) {
    f += dropFrames * 9 * tenMinChunks + dropFrames * Math.floor((remainder - dropFrames) / framesPerMinute);
  } else {
    f += dropFrames * 9 * tenMinChunks;
  }

  const ff = f % nominal;
  const totalSeconds = Math.floor(f / nominal);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)};${pad2(ff)}`;
}

/**
 * Parse a timecode (hh:mm:ss:ff, hh:mm:ss;ff, or mm:ss:ff) into a frame number.
 * Returns null when invalid.
 */
export function timecodeToFrame(tc: string, fps: FrameRate): number | null {
  const trimmed = tc.trim();
  const match = trimmed.match(/^(\d{1,2})[:;](\d{1,2})[:;](\d{1,2})[:;](\d{1,3})$/);
  if (!match) return null;
  const [, hh, mm, ss, ff] = match;
  const nominal = nominalFps(fps);
  if (Number(mm) > 59 || Number(ss) > 59 || Number(ff) >= nominal) return null;
  const base = ((Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * nominal) + Number(ff);
  if (!isDropFrame(fps)) return base;
  // convert from drop-frame label to real frame count
  const dropFrames = Math.round(fpsOf(fps) * 0.066666);
  const totalMinutes = Number(hh) * 60 + Number(mm);
  return base - dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
}

export function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/** Last timeline frame occupied by any clip (exclusive end -> total frames). */
export function sequenceDurationFrames(sequence: Sequence): number {
  let end = 0;
  for (const clip of sequence.clips) {
    end = Math.max(end, clip.startFrame + clip.durationFrames);
  }
  return end;
}

/** Duration in frames of one second, i.e. the fps numerator/denominator pair. */
export function framesPerSecond(fps: FrameRate): number {
  return fps.num / fps.den;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapFrameToSecond(frame: number, fps: FrameRate): number {
  return Math.round(frame / (fps.num / fps.den)) * (fps.num / fps.den);
}

/** frame = whole seconds * fps -> integer frame index (nearest) */
export function framesForSeconds(seconds: number, fps: FrameRate): number {
  return Math.round((seconds * fps.num) / fps.den);
}
