/**
 * Source monitor transport engine.
 *
 * Owns the hidden `<video>`/`<audio>` elements' playback state, keeps the
 * playback store's source frames in sync (rAF during playback), implements
 * In/Out marks and inserts the marked range into the active sequence. The
 * registered `sourcePlayback` API lets the global keyboard shortcut manager
 * drive play/step/mark/insert without prop drilling.
 */
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import type { FrameRate, MediaAsset } from '@/types';
import { IMAGE_CLIP_SECONDS } from '@/engine/timeline/factory';
import { clamp, frameToSeconds, frameToTimecode, secondsToFrame } from '@/utils/time';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { notify } from '@/stores/workspace-store';
import { registerSourcePlayback, type SourcePlaybackApi } from '@/engine/playback/registry';

/** Duration of an asset in the sequence's frame rate (images use the default still length). */
export function sourceDurationFrames(asset: MediaAsset | undefined, fps: FrameRate): number {
  if (!asset) return 0;
  const fpsValue = fps.num / fps.den;
  if (asset.kind === 'image') return Math.max(1, Math.round(IMAGE_CLIP_SECONDS * fpsValue));
  if (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0) return 0;
  return Math.max(1, Math.round(asset.durationSec * fpsValue));
}

export interface SourceTransport {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  audioRef: MutableRefObject<HTMLAudioElement | null>;
  durationFrames: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekFrame: (frame: number) => void;
  step: (deltaFrames: number) => void;
  markIn: () => void;
  markOut: () => void;
  clearMarks: () => void;
  insertIntoSequence: () => void;
  syncElement: () => void;
  handleEnded: () => void;
}

export function useSourceTransport(
  asset: MediaAsset | undefined,
  fps: FrameRate,
  mediaUrl: string | undefined,
): SourceTransport {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const assetRef = useRef(asset);
  assetRef.current = asset;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const urlRef = useRef(mediaUrl);
  urlRef.current = mediaUrl;

  const durationFrames = useMemo(() => sourceDurationFrames(asset, fps), [asset, fps]);
  const durationRef = useRef(durationFrames);
  durationRef.current = durationFrames;

  const playing = usePlaybackStore((s) => s.source.playing);
  const currentFrame = usePlaybackStore((s) => s.source.currentFrame);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const imageFrameAccumulator = useRef(0);

  const getElement = useCallback((): HTMLMediaElement | null => {
    const kind = assetRef.current?.kind;
    if (kind === 'video') return videoRef.current;
    if (kind === 'audio') return audioRef.current;
    return null;
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    rafRef.current = null;
    const playback = usePlaybackStore.getState();
    if (!playback.source.playing) return;
    const currentAsset = assetRef.current;
    if (!currentAsset) return;
    const currentFps = fpsRef.current;
    const total = durationRef.current;
    const outFrame = playback.source.outFrame;
    const stopAt = outFrame !== null ? Math.min(outFrame, total || outFrame) : total;

    if (currentAsset.kind === 'image') {
      const now = performance.now();
      const elapsed = lastTickRef.current
        ? Math.min(0.25, Math.max(0, (now - lastTickRef.current) / 1000))
        : 0;
      lastTickRef.current = now;
      imageFrameAccumulator.current += elapsed * (currentFps.num / currentFps.den);
      const frame = Math.floor(imageFrameAccumulator.current);
      if (frame >= stopAt) {
        playback.setSourceFrame(stopAt);
        playback.setSourcePlaying(false);
        return;
      }
      if (frame !== playback.source.currentFrame) playback.setSourceFrame(frame);
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const element = getElement();
    if (!element) return;
    if (element.ended) {
      element.pause();
      usePlaybackStore.getState().setSourceFrame(outFrame !== null ? Math.min(outFrame, total) : total);
      usePlaybackStore.getState().setSourcePlaying(false);
      return;
    }
    const frame = Math.max(0, secondsToFrame(element.currentTime, currentFps));
    if (outFrame !== null && frame >= outFrame) {
      element.pause();
      usePlaybackStore.getState().setSourceFrame(outFrame);
      usePlaybackStore.getState().setSourcePlaying(false);
      return;
    }
    if (frame !== playback.source.currentFrame) usePlaybackStore.getState().setSourceFrame(frame);
    rafRef.current = requestAnimationFrame(tick);
  }, [getElement]);

  // rAF loop lifecycle driven by the store's playing flag.
  useEffect(() => {
    if (!playing) {
      stopLoop();
      return;
    }
    lastTickRef.current = performance.now();
    imageFrameAccumulator.current = usePlaybackStore.getState().source.currentFrame;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
    return stopLoop;
  }, [playing, tick, stopLoop]);

  // Pause the underlying element when playback is stopped from anywhere.
  useEffect(() => {
    if (playing) return;
    const element = getElement();
    try {
      element?.pause();
    } catch {
      /* ignore */
    }
  }, [playing, getElement]);

  // Keep the element in sync with frame changes while paused (seeks/steps).
  useEffect(() => {
    if (playing) return;
    const element = getElement();
    if (!element) return;
    const seconds = frameToSeconds(currentFrame, fps);
    const elementDuration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
    const target = elementDuration > 0 ? clamp(seconds, 0, elementDuration - 0.001) : seconds;
    try {
      if (Math.abs(element.currentTime - target) > 0.002) element.currentTime = target;
    } catch {
      /* seeking before metadata is ready is safe to ignore */
    }
  }, [currentFrame, playing, getElement, fps]);

  // New media resets playback helpers and stops the previous element.
  useEffect(() => {
    imageFrameAccumulator.current = 0;
    lastTickRef.current = 0;
    const element = getElement();
    try {
      element?.pause();
    } catch {
      /* ignore */
    }
  }, [mediaUrl, getElement]);

  const seekFrame = useCallback(
    (frame: number) => {
      const total = durationRef.current;
      const target = clamp(Math.round(frame), 0, Math.max(0, total));
      usePlaybackStore.getState().setSourceFrame(target);
      imageFrameAccumulator.current = target;
      const element = getElement();
      if (!element) return;
      const elementDuration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
      const seconds = frameToSeconds(target, fpsRef.current);
      const clamped = elementDuration > 0 ? clamp(seconds, 0, elementDuration - 0.001) : seconds;
      try {
        element.currentTime = clamped;
      } catch {
        /* ignore */
      }
    },
    [getElement],
  );

  const pause = useCallback(() => {
    usePlaybackStore.getState().setSourcePlaying(false);
    const element = getElement();
    try {
      element?.pause();
    } catch {
      /* ignore */
    }
  }, [getElement]);

  const play = useCallback(() => {
    const currentAsset = assetRef.current;
    if (!currentAsset) return;
    if (currentAsset.missing || !urlRef.current) {
      notify('error', 'Media is offline', `Relink "${currentAsset.name}" in the Project panel to play it.`);
      return;
    }
    const playback = usePlaybackStore.getState();
    const total = durationRef.current;
    const outFrame = playback.source.outFrame;
    const limit = outFrame !== null ? outFrame : total;
    let start = playback.source.currentFrame;
    if (limit > 0 && start >= limit - 0.5) {
      start = playback.source.inFrame ?? 0;
      seekFrame(start);
    }
    if (currentAsset.kind === 'image') {
      imageFrameAccumulator.current = start;
      lastTickRef.current = performance.now();
      usePlaybackStore.getState().setSourcePlaying(true);
      return;
    }
    const element = getElement();
    if (!element) return;
    const elementDuration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
    const seconds = frameToSeconds(start, fpsRef.current);
    try {
      element.currentTime = elementDuration > 0 ? clamp(seconds, 0, elementDuration - 0.001) : seconds;
    } catch {
      /* ignore */
    }
    element.muted = usePlaybackStore.getState().source.muted;
    try {
      const result = element.play();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          notify(
            'error',
            'Playback could not start',
            'The browser blocked media playback. Click the preview area and try again.',
          );
          usePlaybackStore.getState().setSourcePlaying(false);
        });
      }
    } catch {
      notify('error', 'Playback could not start', 'This media file cannot be played by the browser.');
      return;
    }
    usePlaybackStore.getState().setSourcePlaying(true);
  }, [getElement, seekFrame]);

  const toggle = useCallback(() => {
    if (usePlaybackStore.getState().source.playing) pause();
    else play();
  }, [pause, play]);

  const step = useCallback(
    (deltaFrames: number) => {
      pause();
      seekFrame(usePlaybackStore.getState().source.currentFrame + deltaFrames);
    },
    [pause, seekFrame],
  );

  const markIn = useCallback(() => {
    const playback = usePlaybackStore.getState();
    if (!assetRef.current) return;
    playback.setSourceIn(playback.source.currentFrame);
  }, []);

  const markOut = useCallback(() => {
    const playback = usePlaybackStore.getState();
    if (!assetRef.current) return;
    playback.setSourceOut(playback.source.currentFrame);
  }, []);

  const clearMarks = useCallback(() => {
    usePlaybackStore.getState().clearSourceMarks();
  }, []);

  const insertIntoSequence = useCallback(() => {
    const currentAsset = assetRef.current;
    if (!currentAsset) return;
    if (currentAsset.missing) {
      notify('error', 'Media is offline', `Relink "${currentAsset.name}" before inserting it into the sequence.`);
      return;
    }
    const playback = usePlaybackStore.getState();
    const total = durationRef.current;
    if (total <= 0 && currentAsset.kind !== 'image') {
      notify(
        'warning',
        'Media duration is unknown',
        'The clip cannot be inserted because its duration could not be read.',
      );
      return;
    }
    const inFrame = playback.source.inFrame ?? 0;
    const outFrame = playback.source.outFrame ?? total;
    if (outFrame <= inFrame) {
      notify('warning', 'Marked range is empty', 'Set an Out point after the In point before inserting.');
      return;
    }
    const clipId = useTimelineStore.getState().insertSourceRange(currentAsset.id, inFrame, outFrame);
    if (clipId) {
      notify(
        'success',
        `Inserted "${currentAsset.name}"`,
        `${frameToTimecode(outFrame - inFrame, fpsRef.current)} at the program playhead`,
        2400,
      );
    } else {
      notify(
        'warning',
        'Could not insert into the sequence',
        'Open a sequence with a compatible, unlocked track and try again.',
      );
    }
  }, []);

  /** Called when the media element has metadata: align it with the store frame. */
  const syncElement = useCallback(() => {
    const element = getElement();
    if (!element) return;
    seekFrame(usePlaybackStore.getState().source.currentFrame);
  }, [getElement, seekFrame]);

  const handleEnded = useCallback(() => {
    const playback = usePlaybackStore.getState();
    const total = durationRef.current;
    const outFrame = playback.source.outFrame;
    playback.setSourceFrame(outFrame !== null ? Math.min(outFrame, total) : total);
    playback.setSourcePlaying(false);
  }, []);

  // Register the keyboard-shortcut bridge; removed on unmount.
  useEffect(() => {
    const api: SourcePlaybackApi = {
      play,
      pause,
      toggle,
      seek: seekFrame,
      step,
      markIn,
      markOut,
      clearMarks,
      insertIntoSequence,
      isReady: () => Boolean(assetRef.current && urlRef.current),
    };
    registerSourcePlayback(api);
    return () => registerSourcePlayback(null);
  }, [play, pause, toggle, seekFrame, step, markIn, markOut, clearMarks, insertIntoSequence]);

  // Stop the loop and elements on unmount.
  useEffect(() => {
    return () => {
      stopLoop();
      const video = videoRef.current;
      const audio = audioRef.current;
      try {
        video?.pause();
      } catch {
        /* ignore */
      }
      try {
        audio?.pause();
      } catch {
        /* ignore */
      }
    };
  }, [stopLoop]);

  return {
    videoRef,
    audioRef,
    durationFrames,
    playing,
    play,
    pause,
    toggle,
    seekFrame,
    step,
    markIn,
    markOut,
    clearMarks,
    insertIntoSequence,
    syncElement,
    handleEnded,
  };
}
