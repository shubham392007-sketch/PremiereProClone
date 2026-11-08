import { create } from 'zustand';
import type { PreviewQuality } from '@/types';

export interface SourceMonitorState {
  mediaId: string | null;
  /** source time in sequence frames of the source monitor's project sequence */
  currentFrame: number;
  inFrame: number | null;
  outFrame: number | null;
  playing: boolean;
  scale: 'fit' | number;
  muted: boolean;
}

interface PlaybackState {
  /** program playhead in sequence frames */
  currentFrame: number;
  isPlaying: boolean;
  /** playback direction/speed: 1 = normal, -1 = reverse, 2/4 = fast forward */
  rate: number;
  loop: boolean;
  programScale: 'fit' | number;
  programQuality: PreviewQuality;
  source: SourceMonitorState;

  setCurrentFrame: (frame: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setRate: (rate: number) => void;
  setLoop: (loop: boolean) => void;
  setProgramScale: (scale: 'fit' | number) => void;
  setProgramQuality: (quality: PreviewQuality) => void;

  openSource: (mediaId: string) => void;
  closeSource: () => void;
  setSourceFrame: (frame: number) => void;
  setSourcePlaying: (playing: boolean) => void;
  setSourceIn: (frame: number) => void;
  setSourceOut: (frame: number) => void;
  clearSourceMarks: () => void;
  setSourceScale: (scale: 'fit' | number) => void;
  setSourceMuted: (muted: boolean) => void;
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  currentFrame: 0,
  isPlaying: false,
  rate: 1,
  loop: false,
  programScale: 'fit',
  programQuality: 'full',
  source: {
    mediaId: null,
    currentFrame: 0,
    inFrame: null,
    outFrame: null,
    playing: false,
    scale: 'fit',
    muted: true,
  },

  setCurrentFrame: (frame) => set({ currentFrame: Math.max(0, Math.round(frame)) }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setRate: (rate) => set({ rate }),
  setLoop: (loop) => set({ loop }),
  setProgramScale: (programScale) => set({ programScale }),
  setProgramQuality: (programQuality) => set({ programQuality }),

  openSource: (mediaId) =>
    set({
      source: {
        mediaId,
        currentFrame: 0,
        inFrame: null,
        outFrame: null,
        playing: false,
        scale: 'fit',
        muted: true,
      },
    }),
  closeSource: () =>
    set((state) => ({
      source: { ...state.source, mediaId: null, currentFrame: 0, inFrame: null, outFrame: null, playing: false },
    })),
  setSourceFrame: (frame) =>
    set((state) => ({ source: { ...state.source, currentFrame: Math.max(0, Math.round(frame)) } })),
  setSourcePlaying: (playing) => set((state) => ({ source: { ...state.source, playing } })),
  setSourceIn: (frame) =>
    set((state) => {
      const inFrame = Math.max(0, Math.round(frame));
      const outFrame = state.source.outFrame;
      return {
        source: {
          ...state.source,
          inFrame,
          outFrame: outFrame !== null && outFrame <= inFrame ? null : outFrame,
        },
      };
    }),
  setSourceOut: (frame) =>
    set((state) => {
      const inFrame = state.source.inFrame;
      const outFrame = Math.max(0, Math.round(frame));
      return {
        source: {
          ...state.source,
          outFrame,
          inFrame: inFrame !== null && inFrame >= outFrame ? outFrame - 1 : inFrame,
        },
      };
    }),
  clearSourceMarks: () =>
    set((state) => ({ source: { ...state.source, inFrame: null, outFrame: null } })),
  setSourceScale: (scale) => set((state) => ({ source: { ...state.source, scale } })),
  setSourceMuted: (muted) => set((state) => ({ source: { ...state.source, muted } })),
}));
