import { describe, expect, it } from 'vitest';
import { frameAtElapsedMs, integerFrameAtElapsedMs, msPerFrameOf } from './playback-clock';

const FPS30 = msPerFrameOf(30, 1); // 33.333… ms
const FPS2997 = msPerFrameOf(30000, 1001); // 33.3667 ms

describe('playback-clock', () => {
  it('advances exactly one sequence frame per frame duration at 1×', () => {
    expect(integerFrameAtElapsedMs(0, 0, 1, FPS30)).toBe(0);
    expect(integerFrameAtElapsedMs(0, 16, 1, FPS30)).toBe(0);
    expect(integerFrameAtElapsedMs(0, 33.34, 1, FPS30)).toBe(1);
    expect(integerFrameAtElapsedMs(0, 1000, 1, FPS30)).toBe(30);
    expect(integerFrameAtElapsedMs(0, 60_000, 1, FPS30)).toBe(1800);
  });

  it('respects fractional frame rates (29.97)', () => {
    expect(integerFrameAtElapsedMs(0, FPS2997, 1, FPS2997)).toBe(1);
    expect(integerFrameAtElapsedMs(0, 10_000, 1, FPS2997)).toBe(299);
  });

  it('multiplies distance by the playback rate', () => {
    // 500 ms at 30 fps is 15 frames; at 2× the playhead covers 30.
    expect(integerFrameAtElapsedMs(0, 500, 2, FPS30)).toBe(30);
    expect(integerFrameAtElapsedMs(0, 500, 4, FPS30)).toBe(60);
    expect(integerFrameAtElapsedMs(0, 500, 0.5, FPS30)).toBe(7);
  });

  it('moves backwards for negative rates (reverse playback)', () => {
    const start = 100;
    expect(frameAtElapsedMs(start, 0, -1, FPS30)).toBe(100);
    expect(integerFrameAtElapsedMs(start, 1000, -1, FPS30)).toBe(70);
    expect(integerFrameAtElapsedMs(start, 333.0, -1, FPS30)).toBe(90);
    expect(integerFrameAtElapsedMs(start, 3333.0, -1, FPS30)).toBe(0);
  });

  it('can extrapolate below zero so the engine can clamp / loop', () => {
    expect(integerFrameAtElapsedMs(10, 1000, -1, FPS30)).toBe(-20);
  });

  it('falls back safely for invalid clock state', () => {
    expect(frameAtElapsedMs(42, 1000, 1, 0)).toBe(42);
    expect(frameAtElapsedMs(42, 1000, 1, Number.NaN)).toBe(42);
    expect(frameAtElapsedMs(42, 1000, Number.NaN, FPS30)).toBe(42);
  });

  it('does not stall on exact frame boundaries (epsilon floor)', () => {
    // 4 frame durations at 30 fps, computed in floating point.
    const elapsed = FPS30 * 4;
    expect(integerFrameAtElapsedMs(7, elapsed, 1, FPS30)).toBe(11);
  });
});
