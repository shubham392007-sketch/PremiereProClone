import type { FrameRate } from '@/types';

/** Convert an integer frame position to pixels at a given pixels-per-second zoom. */
export function frameToPixels(frame: number, fps: FrameRate, pixelsPerSecond: number): number {
  return ((frame * fps.den) / fps.num) * pixelsPerSecond;
}

/** Convert a pixel offset to a (rounded) frame position. */
export function pixelsToFrame(px: number, fps: FrameRate, pixelsPerSecond: number): number {
  return Math.round((px / pixelsPerSecond) * (fps.num / fps.den));
}

/** Pixel width of a number of frames. */
export function framesToWidth(frames: number, fps: FrameRate, pixelsPerSecond: number): number {
  return (frames / (fps.num / fps.den)) * pixelsPerSecond;
}

export function pixelWidthOfFrame(fps: FrameRate, pixelsPerSecond: number): number {
  return (fps.den / fps.num) * pixelsPerSecond;
}

/** Choose a sensible ruler tick interval for the current zoom. */
export function chooseRulerInterval(pixelsPerSecond: number, fps: FrameRate): { frames: number; major: boolean } {
  const f = fps.num / fps.den;
  const candidates = [
    { frames: 1, major: false },
    { frames: Math.max(1, Math.round(f / 2)), major: false },
    { frames: Math.round(f), major: true },
    { frames: Math.round(f * 2), major: false },
    { frames: Math.round(f * 5), major: true },
    { frames: Math.round(f * 10), major: true },
    { frames: Math.round(f * 30), major: true },
    { frames: Math.round(f * 60), major: true },
    { frames: Math.round(f * 300), major: true },
    { frames: Math.round(f * 600), major: true },
  ];
  for (const candidate of candidates) {
    const px = (candidate.frames / f) * pixelsPerSecond;
    if (px >= 64) return candidate;
  }
  return candidates[candidates.length - 1];
}
