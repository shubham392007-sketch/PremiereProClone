/**
 * Small indirection layer between UI/keyboard shortcuts and the playback
 * engines. The Program/Source monitor components register their engine here,
 * so keyboard shortcuts and toolbar buttons work without prop drilling or
 * coupling to the engine implementation.
 */

export interface ProgramPlaybackApi {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (frame: number, options?: { keepPlaying?: boolean }) => void;
  step: (deltaFrames: number) => void;
  jumpToStart: () => void;
  jumpToEnd: () => void;
  setRate: (rate: number) => void;
  isReady: () => boolean;
}

export interface SourcePlaybackApi {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (frame: number) => void;
  step: (deltaFrames: number) => void;
  markIn: () => void;
  markOut: () => void;
  clearMarks: () => void;
  insertIntoSequence: () => void;
  isReady: () => boolean;
}

let programApi: ProgramPlaybackApi | null = null;
let sourceApi: SourcePlaybackApi | null = null;

export function registerProgramPlayback(api: ProgramPlaybackApi | null): void {
  programApi = api;
}

export function registerSourcePlayback(api: SourcePlaybackApi | null): void {
  sourceApi = api;
}

export const programPlayback: ProgramPlaybackApi = {
  play: () => programApi?.play(),
  pause: () => programApi?.pause(),
  toggle: () => programApi?.toggle(),
  seek: (frame, options) => programApi?.seek(frame, options),
  step: (delta) => programApi?.step(delta),
  jumpToStart: () => programApi?.jumpToStart(),
  jumpToEnd: () => programApi?.jumpToEnd(),
  setRate: (rate) => programApi?.setRate(rate),
  isReady: () => Boolean(programApi?.isReady()),
};

export const sourcePlayback: SourcePlaybackApi = {
  play: () => sourceApi?.play(),
  pause: () => sourceApi?.pause(),
  toggle: () => sourceApi?.toggle(),
  seek: (frame) => sourceApi?.seek(frame),
  step: (delta) => sourceApi?.step(delta),
  markIn: () => sourceApi?.markIn(),
  markOut: () => sourceApi?.markOut(),
  clearMarks: () => sourceApi?.clearMarks(),
  insertIntoSequence: () => sourceApi?.insertIntoSequence(),
  isReady: () => Boolean(sourceApi?.isReady()),
};

export function hasProgramPlayback(): boolean {
  return Boolean(programApi);
}
