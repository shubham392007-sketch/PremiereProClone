import { create } from 'zustand';
import type { MediaAsset, Project, Sequence, TimelineClip, Track, TrackKind, EditorTool } from '@/types';
import { MEDIA_COLORS } from '@/utils/presets';
import { clamp } from '@/utils/time';
import { secondsToFrame } from '@/utils/time';
import {
  addClip,
  addMarker,
  addTrack,
  clipEnd,
  deleteClips,
  duplicateClips,
  getAudioTracks,
  getClip,
  getTrack,
  getVideoTracks,
  linkedClipIds,
  moveClips,
  reorderTrack,
  sequenceEndFrame,
  setClipsEnabled,
  splitAllAtFrame,
  splitClip,
  trimClipEnd,
  trimClipStart,
  updateTrack,
  deleteTrack as deleteTrackOp,
} from '@/engine/timeline/operations';
import {
  defaultClipDurationFrames,
  findSequence,
  makeClip,
} from '@/engine/timeline/factory';
import { defaultAudioProps, defaultTransform } from '@/engine/timeline/factory';
import { createId } from '@/utils/id';
import { useProjectStore, getActiveSequence } from './project-store';
import { usePlaybackStore } from './playback-store';
import { notify } from './workspace-store';

interface ClipboardItem {
  clip: TimelineClip;
  trackKind: TrackKind;
}

interface TimelineState {
  selectedClipIds: string[];
  selectedTrackId: string | null;
  tool: EditorTool;
  snapping: boolean;
  clipboard: ClipboardItem[];
  zoomPixelsPerSecond: number;
  scrollLeft: number;
  scrollTop: number;
  /** true while a pointer drag edits the sequence (prevents redundant UI work) */
  interacting: boolean;

  setTool: (tool: EditorTool) => void;
  setSnapping: (snapping: boolean) => void;
  setInteracting: (interacting: boolean) => void;
  setZoom: (pixelsPerSecond: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: (viewportWidthPx: number) => void;
  zoomToSelection: (viewportWidthPx: number) => void;
  setScroll: (left: number, top?: number) => void;
  initFromWorkspace: (workspace: Project['workspace']) => void;

  selectClips: (ids: string[], mode?: 'replace' | 'add' | 'toggle') => void;
  selectTrack: (trackId: string | null) => void;
  clearSelection: () => void;
  selectAllClips: () => void;

  edit: (label: string, mutator: (sequence: Sequence) => void, opts?: { history?: boolean }) => void;
  beginEdit: () => Project | null;
  liveEdit: (mutator: (sequence: Sequence) => void) => void;
  endEdit: (before: Project, label: string) => void;

  deleteClipsByIds: (ids: string[], label?: string) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  cutSelection: () => void;
  pasteAtPlayhead: () => void;
  splitAtPlayhead: (allTracks?: boolean) => void;
  splitClipAt: (clipId: string, frame: number) => void;
  nudgeSelection: (deltaFrames: number) => void;
  toggleSelectedEnabled: () => void;
  setClipProperties: (clipId: string, patch: Partial<TimelineClip>, label?: string) => void;

  insertMediaAt: (mediaId: string, targetTrackId: string | null, startFrame: number) => string | null;
  insertSourceRange: (mediaId: string, inFrame: number, outFrame: number) => string | null;

  addTrack: (kind: TrackKind) => void;
  removeTrack: (trackId: string) => void;
  patchTrack: (trackId: string, patch: Partial<Track>, label?: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  reorderTrack: (trackId: string, direction: -1 | 1) => void;

  addMarkerAtPlayhead: () => void;
  removeMarkerById: (markerId: string) => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWorkspacePersist(get: () => TimelineState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state = get();
    useProjectStore.getState().updateWorkspace({
      timelinePixelsPerSecond: state.zoomPixelsPerSecond,
      timelineScrollLeft: state.scrollLeft,
      timelineScrollTop: state.scrollTop,
    });
  }, 700);
}

function chooseTrackForAsset(sequence: Sequence, asset: MediaAsset, requestedTrackId: string | null): Track | null {
  const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
  const requested = requestedTrackId ? getTrack(sequence, requestedTrackId) : null;
  if (requested && requested.kind === kind) return requested;
  const peers = kind === 'video' ? getVideoTracks(sequence) : getAudioTracks(sequence);
  return peers[0] ?? null;
}

function sourceMaxDurationFrames(asset: MediaAsset, sequence: Sequence): number {
  if (asset.kind === 'image') return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.round((asset.durationSec * sequence.frameRate.num) / sequence.frameRate.den));
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  selectedClipIds: [],
  selectedTrackId: null,
  tool: 'select',
  snapping: true,
  clipboard: [],
  zoomPixelsPerSecond: 60,
  scrollLeft: 0,
  scrollTop: 0,
  interacting: false,

  setTool: (tool) => set({ tool }),
  setSnapping: (snapping) => set({ snapping }),
  setInteracting: (interacting) => set({ interacting }),

  setZoom: (pixelsPerSecond) => {
    set({ zoomPixelsPerSecond: clamp(pixelsPerSecond, 2, 4000) });
    scheduleWorkspacePersist(get);
  },
  zoomIn: () => {
    set({ zoomPixelsPerSecond: clamp(get().zoomPixelsPerSecond * 1.4, 2, 4000) });
    scheduleWorkspacePersist(get);
  },
  zoomOut: () => {
    set({ zoomPixelsPerSecond: clamp(get().zoomPixelsPerSecond / 1.4, 2, 4000) });
    scheduleWorkspacePersist(get);
  },
  zoomToFit: (viewportWidthPx) => {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const end = Math.max(sequenceEndFrame(sequence), 1);
    const fps = sequence.frameRate.num / sequence.frameRate.den;
    const durationSec = end / fps;
    const pps = clamp((Math.max(120, viewportWidthPx) - 24) / Math.max(0.25, durationSec), 2, 4000);
    set({ zoomPixelsPerSecond: pps, scrollLeft: 0 });
    scheduleWorkspacePersist(get);
  },
  zoomToSelection: (viewportWidthPx) => {
    const sequence = getActiveSequence();
    const selected = get().selectedClipIds;
    if (!sequence || !selected.length) {
      get().zoomToFit(viewportWidthPx);
      return;
    }
    const clips = sequence.clips.filter((c) => selected.includes(c.id));
    const start = Math.min(...clips.map((c) => c.startFrame));
    const end = Math.max(...clips.map((c) => clipEnd(c)));
    const fps = sequence.frameRate.num / sequence.frameRate.den;
    const pps = clamp((Math.max(120, viewportWidthPx) - 80) / Math.max(0.1, (end - start) / fps), 2, 4000);
    set({ zoomPixelsPerSecond: pps });
    set({ scrollLeft: Math.max(0, start / fps) * pps - 40 });
    scheduleWorkspacePersist(get);
  },
  setScroll: (scrollLeft, scrollTop) => {
    set((state) => ({
      scrollLeft: Math.max(0, scrollLeft),
      scrollTop: scrollTop === undefined ? state.scrollTop : Math.max(0, scrollTop),
    }));
    scheduleWorkspacePersist(get);
  },
  initFromWorkspace: (workspace) =>
    set({
      zoomPixelsPerSecond: workspace.timelinePixelsPerSecond,
      scrollLeft: workspace.timelineScrollLeft,
      scrollTop: workspace.timelineScrollTop,
      selectedClipIds: [],
      selectedTrackId: null,
      clipboard: [],
      tool: 'select',
      interacting: false,
    }),

  selectClips: (ids, mode = 'replace') => {
    set((state) => {
      if (mode === 'replace') return { selectedClipIds: [...new Set(ids)] };
      if (mode === 'add') return { selectedClipIds: [...new Set([...state.selectedClipIds, ...ids])] };
      const next = new Set(state.selectedClipIds);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return { selectedClipIds: [...next] };
    });
  },
  selectTrack: (trackId) => set({ selectedTrackId: trackId }),
  clearSelection: () => set({ selectedClipIds: [] }),
  selectAllClips: () => {
    const sequence = getActiveSequence();
    if (!sequence) return;
    set({ selectedClipIds: sequence.clips.map((c) => c.id) });
  },

  edit: (label, mutator, opts) => {
    useProjectStore.getState().updateSequence(mutator, label, opts);
  },
  beginEdit: () => useProjectStore.getState().snapshotProject(),
  liveEdit: (mutator) => {
    useProjectStore.getState().updateSequence(mutator, 'Edit', { history: false });
  },
  endEdit: (before, label) => {
    useProjectStore.getState().commitSnapshot(before, label);
  },

  deleteClipsByIds: (ids, label = 'Delete clip') => {
    if (!ids.length) return;
    const sequence = getActiveSequence();
    if (!sequence) return;
    // include linked clips
    const all = new Set<string>();
    for (const id of ids) {
      for (const linked of linkedClipIds(sequence, id)) all.add(linked);
    }
    get().edit(label, (draft) => {
      deleteClips(draft, [...all]);
    });
    set((state) => ({ selectedClipIds: state.selectedClipIds.filter((id) => !all.has(id)) }));
  },
  deleteSelection: () => {
    get().deleteClipsByIds(get().selectedClipIds);
  },
  duplicateSelection: () => {
    const ids = get().selectedClipIds;
    if (!ids.length) return;
    const sequence = getActiveSequence();
    if (!sequence) return;
    const selected = sequence.clips.filter((c) => ids.includes(c.id));
    const start = Math.min(...selected.map((c) => c.startFrame));
    const end = Math.max(...selected.map((c) => clipEnd(c)));
    let newIds: string[] = [];
    get().edit('Duplicate clip', (draft) => {
      newIds = duplicateClips(draft, ids, end - start);
    });
    set({ selectedClipIds: newIds });
  },
  copySelection: () => {
    const sequence = getActiveSequence();
    const ids = get().selectedClipIds;
    if (!sequence || !ids.length) return;
    const items: ClipboardItem[] = [];
    for (const clip of sequence.clips) {
      if (!ids.includes(clip.id)) continue;
      const track = getTrack(sequence, clip.trackId);
      if (track) items.push({ clip: structuredClone(clip), trackKind: track.kind });
    }
    set({ clipboard: items });
    notify('info', `Copied ${items.length} clip${items.length === 1 ? '' : 's'}`, undefined, 1800);
  },
  cutSelection: () => {
    get().copySelection();
    get().deleteSelection();
  },
  pasteAtPlayhead: () => {
    const clipboard = get().clipboard;
    if (!clipboard.length) return;
    const playhead = usePlaybackStore.getState().currentFrame;
    const sequence = getActiveSequence();
    if (!sequence) return;
    const base = Math.min(...clipboard.map((item) => item.clip.startFrame));
    const delta = Math.max(0, playhead - base);
    const idMap = new Map<string, string>();
    const newIds: string[] = [];
    get().edit('Paste clip', (draft) => {
      const items = [...clipboard];
      for (const { clip, trackKind } of items) {
        const track = getTrack(draft, clip.trackId) ?? (trackKind === 'video' ? getVideoTracks(draft)[0] : getAudioTracks(draft)[0]);
        if (!track) continue;
        const copy: TimelineClip = {
          ...structuredClone(clip),
          id: createId('clip'),
          trackId: track.id,
          startFrame: clip.startFrame + delta,
          linkedClipId: null,
        };
        idMap.set(clip.id, copy.id);
        newIds.push(copy.id);
        addClip(draft, copy);
      }
      for (const copy of draft.clips) {
        if (copy.linkedClipId && idMap.has(copy.linkedClipId)) copy.linkedClipId = idMap.get(copy.linkedClipId)!;
      }
    });
    set({ selectedClipIds: newIds });
  },
  splitAtPlayhead: (allTracks = false) => {
    const frame = usePlaybackStore.getState().currentFrame;
    const sequence = getActiveSequence();
    if (!sequence) return;
    const targets = allTracks
      ? sequence.clips.filter((c) => frame > c.startFrame && frame < clipEnd(c))
      : sequence.clips.filter(
          (c) =>
            get().selectedClipIds.includes(c.id) && frame > c.startFrame && frame < clipEnd(c),
        );
    if (!targets.length) {
      notify('info', 'Playhead is not over a clip to split', undefined, 2000);
      return;
    }
    const newRightIds: string[] = [];
    get().edit('Split clip', (draft) => {
      for (const clip of targets) {
        const right = splitClip(draft, clip.id, frame);
        if (right) newRightIds.push(right.id);
      }
    });
    set({ selectedClipIds: newRightIds });
  },
  splitClipAt: (clipId, frame) => {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const clip = sequence.clips.find((c) => c.id === clipId);
    if (!clip || frame <= clip.startFrame || frame >= clipEnd(clip)) return;
    let rightId: string | null = null;
    get().edit('Razor clip', (draft) => {
      const right = splitClip(draft, clipId, frame);
      rightId = right?.id ?? null;
    });
    set({ selectedClipIds: rightId ? [rightId] : [] });
  },
  nudgeSelection: (deltaFrames) => {
    const ids = get().selectedClipIds;
    if (!ids.length || deltaFrames === 0) return;
    get().edit(deltaFrames > 0 ? 'Move clip forward' : 'Move clip backward', (draft) => {
      moveClips(draft, ids, deltaFrames);
    });
  },
  toggleSelectedEnabled: () => {
    const sequence = getActiveSequence();
    const ids = get().selectedClipIds;
    if (!sequence || !ids.length) return;
    const anyEnabled = sequence.clips.some((c) => ids.includes(c.id) && c.enabled);
    get().edit(anyEnabled ? 'Disable clip' : 'Enable clip', (draft) => {
      setClipsEnabled(draft, ids, !anyEnabled);
    });
  },
  setClipProperties: (clipId, patch, label = 'Adjust clip') => {
    get().edit(label, (draft) => {
      const clip = getClip(draft, clipId);
      if (!clip) return;
      if (patch.transform) patch = { ...patch, transform: { ...clip.transform, ...patch.transform } };
      if (patch.audio) patch = { ...patch, audio: { ...clip.audio, ...patch.audio } };
      Object.assign(clip, patch);
    });
  },

  insertMediaAt: (mediaId, targetTrackId, startFrame) => {
    const project = useProjectStore.getState().project;
    if (!project) return null;
    const asset = project.media.find((m) => m.id === mediaId);
    const sequence = findSequence(project);
    if (!asset || !sequence) return null;
    if (asset.missing) {
      notify('error', 'Media is offline', `Re-import "${asset.name}" to use it on the timeline.`);
      return null;
    }
    const track = chooseTrackForAsset(sequence, asset, targetTrackId);
    if (!track) {
      notify('error', 'No compatible track', `Add a ${asset.kind === 'audio' ? 'audio' : 'video'} track before inserting this media.`);
      return null;
    }
    if (track.locked) {
      notify('warning', 'Track is locked', `Unlock ${track.name} to add clips.`);
      return null;
    }
    const duration = defaultClipDurationFrames(asset, sequence.frameRate);
    const clip = makeClip({
      mediaId: asset.id,
      trackId: track.id,
      startFrame: Math.max(0, Math.round(startFrame)),
      durationFrames: duration,
      sourceInFrame: 0,
      color: MEDIA_COLORS[asset.kind],
      name: asset.name,
    });
    get().edit('Add clip to timeline', (draft) => {
      addClip(draft, clip);
    });
    set({ selectedClipIds: [clip.id], selectedTrackId: track.id });
    return clip.id;
  },

  insertSourceRange: (mediaId, inFrame, outFrame) => {
    const project = useProjectStore.getState().project;
    if (!project) return null;
    const asset = project.media.find((m) => m.id === mediaId);
    const sequence = findSequence(project);
    if (!asset || !sequence) return null;
    const track = chooseTrackForAsset(sequence, asset, get().selectedTrackId);
    if (!track) return null;
    const start = usePlaybackStore.getState().currentFrame;
    const duration = Math.max(1, outFrame - inFrame);
    const clip = makeClip({
      mediaId: asset.id,
      trackId: track.id,
      startFrame: start,
      durationFrames: duration,
      sourceInFrame: inFrame,
      color: MEDIA_COLORS[asset.kind],
      name: asset.name,
    });
    get().edit('Insert source range', (draft) => {
      addClip(draft, clip);
    });
    set({ selectedClipIds: [clip.id], selectedTrackId: track.id });
    return clip.id;
  },

  addTrack: (kind) => {
    let name = '';
    get().edit(`Add ${kind} track`, (draft) => {
      const track = addTrack(draft, kind);
      name = track.name;
    });
    notify('success', `${name || (kind === 'video' ? 'Video' : 'Audio')} track added`, undefined, 1800);
  },
  removeTrack: (trackId) => {
    let error: string | null = null;
    get().edit('Delete track', (draft) => {
      const result = deleteTrackOp(draft, trackId);
      if (!result.ok) error = result.reason ?? 'Unable to delete track';
    });
    if (error) {
      notify('warning', 'Track was not deleted', error);
    } else {
      set({ selectedTrackId: null });
    }
  },
  patchTrack: (trackId, patch, label = 'Update track') => {
    get().edit(label, (draft) => {
      updateTrack(draft, trackId, patch);
    });
  },
  renameTrack: (trackId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().edit('Rename track', (draft) => {
      updateTrack(draft, trackId, { name: trimmed });
    });
  },
  reorderTrack: (trackId, direction) => {
    get().edit('Reorder track', (draft) => {
      reorderTrack(draft, trackId, direction);
    });
  },

  addMarkerAtPlayhead: () => {
    const frame = usePlaybackStore.getState().currentFrame;
    get().edit('Add marker', (draft) => {
      addMarker(draft, frame);
    });
  },
  removeMarkerById: (markerId) => {
    get().edit('Remove marker', (draft) => {
      draft.markers = draft.markers.filter((m) => m.id !== markerId);
    });
  },
}));

/** Get maximum source duration for trim clamping (in sequence frames). */
export function getSourceMaxFrames(asset: MediaAsset | undefined, sequence: Sequence): number {
  if (!asset) return Number.MAX_SAFE_INTEGER;
  return sourceMaxDurationFrames(asset, sequence);
}

/** Utility used by monitor + timeline for source-range insertion limits. */
export function getAssetDurationFrames(asset: MediaAsset, sequence: Sequence): number {
  if (asset.kind === 'image') return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.round(asset.durationSec * (sequence.frameRate.num / sequence.frameRate.den)));
}

export function getSelectedClips(): TimelineClip[] {
  const sequence = getActiveSequence();
  if (!sequence) return [];
  return sequence.clips.filter((c) => useTimelineStore.getState().selectedClipIds.includes(c.id));
}

export function mediaFrameToSequenceFrame(asset: MediaAsset, seconds: number, sequence: Sequence): number {
  return secondsToFrame(seconds, sequence.frameRate);
}

export { sourceMaxDurationFrames, defaultTransform, defaultAudioProps };
