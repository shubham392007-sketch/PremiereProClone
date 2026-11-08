import { describe, expect, it } from 'vitest';
import type { FrameRate } from '@/types';
import {
  frameToSeconds,
  frameToTimecode,
  framesForSeconds,
  secondsToFrame,
  timecodeToFrame,
} from './time';
import { frameToPixels, pixelsToFrame } from './timeline-geometry';

const FPS_30: FrameRate = { num: 30, den: 1, label: '30' };
const FPS_2997: FrameRate = { num: 30000, den: 1001, label: '29.97' };
const FPS_23976: FrameRate = { num: 24000, den: 1001, label: '23.976' };
const FPS_24: FrameRate = { num: 24, den: 1, label: '24' };

describe('frame <-> time conversion', () => {
  it('converts frames to seconds exactly using rational frame rate', () => {
    expect(frameToSeconds(30, FPS_30)).toBe(1);
    expect(frameToSeconds(150, FPS_30)).toBe(5);
    expect(secondsToFrame(2.5, FPS_30)).toBe(75);
    expect(secondsToFrame(1, FPS_2997)).toBe(30);
    expect(framesForSeconds(10, FPS_24)).toBe(240);
  });

  it('converts frame positions to pixels at the current zoom', () => {
    expect(frameToPixels(30, FPS_30, 60)).toBe(60);
    expect(frameToPixels(15, FPS_30, 60)).toBe(30);
    expect(pixelsToFrame(60, FPS_30, 60)).toBe(30);
    expect(pixelsToFrame(0, FPS_30, 60)).toBe(0);
  });
});

describe('timecode', () => {
  it('formats non-drop timecode at integer rates', () => {
    expect(frameToTimecode(0, FPS_30)).toBe('00:00:00:00');
    expect(frameToTimecode(29, FPS_30)).toBe('00:00:00:29');
    expect(frameToTimecode(30, FPS_30)).toBe('00:00:01:00');
    expect(frameToTimecode(108000, FPS_30)).toBe('01:00:00:00');
    expect(frameToTimecode(24, FPS_24)).toBe('00:00:01:00');
  });

  it('formats 23.976 as non-drop timecode', () => {
    expect(frameToTimecode(24, FPS_23976)).toBe('00:00:01:00');
    expect(frameToTimecode(48, FPS_23976)).toBe('00:00:02:00');
  });

  it('formats drop-frame timecode at 29.97', () => {
    expect(frameToTimecode(0, FPS_2997)).toBe('00:00:00;00');
    expect(frameToTimecode(30, FPS_2997)).toBe('00:00:01;00');
    expect(frameToTimecode(1799, FPS_2997)).toBe('00:00:59;29');
    expect(frameToTimecode(1800, FPS_2997)).toBe('00:01:00;02');
    expect(frameToTimecode(17982, FPS_2997)).toBe('00:10:00;00');
    expect(frameToTimecode(17983, FPS_2997)).toBe('00:10:00;01');
  });

  it('parses timecode back to exact frames including drop-frame', () => {
    expect(timecodeToFrame('00:00:01:00', FPS_30)).toBe(30);
    expect(timecodeToFrame('01:00:00:00', FPS_30)).toBe(108000);
    expect(timecodeToFrame('00:01:00;02', FPS_2997)).toBe(1800);
    expect(timecodeToFrame('00:10:00;00', FPS_2997)).toBe(17982);
    expect(timecodeToFrame('bad', FPS_30)).toBeNull();
    expect(timecodeToFrame('00:99:00:00', FPS_30)).toBeNull();
  });

  it('round-trips normal drop-frame positions', () => {
    for (const frame of [0, 1, 29, 30, 1799, 1802, 3599, 18000, 17982, 17983, 100000]) {
      const tc = frameToTimecode(frame, FPS_2997);
      expect(timecodeToFrame(tc, FPS_2997)).toBe(frame);
    }
  });
});
