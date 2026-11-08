/**
 * Pure playback-clock math.
 *
 * Kept separate from the engine so the frame-accurate, performance.now-based
 * clock can be unit tested without a DOM. The clock never depends on React
 * render cadence: elapsed wall-clock time is converted to sequence frames.
 */

/**
 * Continuous (fractional) sequence frame at `elapsedMs` after the anchor.
 * Supports negative rates for reverse playback.
 */
export function frameAtElapsedMs(
  startFrame: number,
  elapsedMs: number,
  rate: number,
  msPerFrame: number,
): number {
  if (!Number.isFinite(msPerFrame) || msPerFrame <= 0 || !Number.isFinite(rate)) {
    return startFrame;
  }
  return startFrame + (elapsedMs * rate) / msPerFrame;
}

/**
 * Integer frame displayed by the playback clock. Uses floor with a tiny
 * epsilon so floating point error cannot stall the playhead on a boundary.
 */
export function integerFrameAtElapsedMs(
  startFrame: number,
  elapsedMs: number,
  rate: number,
  msPerFrame: number,
): number {
  return Math.floor(frameAtElapsedMs(startFrame, elapsedMs, rate, msPerFrame) + 1e-6);
}

/** Convert a frame rate pair to milliseconds per frame. */
export function msPerFrameOf(num: number, den: number): number {
  if (!Number.isFinite(num) || num <= 0 || !Number.isFinite(den) || den <= 0) return 1000 / 30;
  return (1000 * den) / num;
}
