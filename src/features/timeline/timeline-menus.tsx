import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Clipboard,
  Copy,
  Flag,
  Gauge,
  Maximize2,
  MousePointer2,
  Music,
  Pencil,
  Plus,
  Power,
  Rows3,
  Scissors,
  Trash2,
  Video,
} from 'lucide-react';
import type { ContextMenuItem } from '@/components/common/ContextMenu';
import type { Marker, Track } from '@/types';
import { getActiveSequence } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { frameToTimecode } from '@/utils/time';
import { LARGE_TRACK_HEIGHT, SMALL_TRACK_HEIGHT, VIDEO_TRACK_HEIGHT } from './timeline-constants';
import { tracksOfKind } from './timeline-helpers';

function icon(node: ReactNode): ReactNode {
  return node;
}

function applyClipSpeed(clipId: string, playbackRate: number): void {
  const sequence = getActiveSequence();
  const clip = sequence?.clips.find((candidate) => candidate.id === clipId);
  if (!clip) return;
  // Preserve the consumed source range while the speed changes the duration.
  const sourceSpanFrames = clip.durationFrames * clip.playbackRate;
  const nextDuration = Math.max(1, Math.round(sourceSpanFrames / playbackRate));
  useTimelineStore
    .getState()
    .setClipProperties(clipId, { playbackRate, durationFrames: nextDuration }, 'Change clip speed');
}

export function buildClipMenuItems(clipId: string): ContextMenuItem[] {
  const sequence = getActiveSequence();
  const clip = sequence?.clips.find((candidate) => candidate.id === clipId);
  if (!clip) return [];
  const store = useTimelineStore.getState();
  const ensureSelected = () => {
    const current = useTimelineStore.getState();
    if (!current.selectedClipIds.includes(clipId)) current.selectClips([clipId], 'replace');
  };

  return [
    {
      label: 'Cut',
      icon: icon(<Scissors size={13} />),
      shortcut: 'Ctrl+X',
      onClick: () => {
        ensureSelected();
        useTimelineStore.getState().cutSelection();
      },
    },
    {
      label: 'Copy',
      icon: icon(<Copy size={13} />),
      shortcut: 'Ctrl+C',
      onClick: () => {
        ensureSelected();
        useTimelineStore.getState().copySelection();
      },
    },
    {
      label: 'Paste',
      icon: icon(<Clipboard size={13} />),
      shortcut: 'Ctrl+V',
      disabled: store.clipboard.length === 0,
      onClick: () => useTimelineStore.getState().pasteAtPlayhead(),
    },
    { separator: true },
    {
      label: 'Delete',
      icon: icon(<Trash2 size={13} />),
      shortcut: 'Del',
      danger: true,
      onClick: () => {
        ensureSelected();
        useTimelineStore.getState().deleteSelection();
      },
    },
    {
      label: 'Duplicate',
      icon: icon(<Copy size={13} />),
      shortcut: 'Ctrl+D',
      onClick: () => {
        ensureSelected();
        useTimelineStore.getState().duplicateSelection();
      },
    },
    {
      label: 'Split at Playhead',
      icon: icon(<Scissors size={13} />),
      shortcut: 'Ctrl+K',
      onClick: () => {
        ensureSelected();
        useTimelineStore.getState().splitAtPlayhead(false);
      },
    },
    { separator: true },
    {
      label: clip.enabled ? 'Disable Clip' : 'Enable Clip',
      icon: icon(<Power size={13} />),
      checked: clip.enabled,
      onClick: () => {
        ensureSelected();
        useTimelineStore.getState().toggleSelectedEnabled();
      },
    },
    {
      label: 'Speed',
      icon: icon(<Gauge size={13} />),
      submenu: [0.5, 1, 1.5, 2].map((rate) => ({
        label: `${rate}x`,
        checked: Math.abs(clip.playbackRate - rate) < 0.001,
        onClick: () => applyClipSpeed(clipId, rate),
      })),
    },
  ];
}

export interface TrackMenuHandlers {
  onRename: (trackId: string) => void;
}

export function buildTrackMenuItems(trackId: string, handlers: TrackMenuHandlers): ContextMenuItem[] {
  const sequence = getActiveSequence();
  if (!sequence) return [];
  const track = sequence.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return [];
  const peers = tracksOfKind(sequence, track.kind);
  const position = peers.indexOf(track);
  const maxIndex = peers.length - 1;
  const hasClips = sequence.clips.some((clip) => clip.trackId === trackId);
  const canDelete = !hasClips && peers.length > 1;

  // Display-up for video is a higher index (V2 renders above V1); for audio it is a lower index.
  const upDirection: -1 | 1 = track.kind === 'video' ? 1 : -1;
  const downDirection: -1 | 1 = upDirection === 1 ? -1 : 1;
  const canMoveUp = track.kind === 'video' ? track.index < maxIndex : track.index > 0;
  const canMoveDown = track.kind === 'video' ? track.index > 0 : track.index < maxIndex;

  const heightItems: ContextMenuItem[] = [
    {
      label: 'Small',
      checked: track.height === SMALL_TRACK_HEIGHT,
      onClick: () => useTimelineStore.getState().patchTrack(trackId, { height: SMALL_TRACK_HEIGHT }, 'Resize track'),
    },
    {
      label: 'Medium',
      checked: track.height === (track.kind === 'video' ? VIDEO_TRACK_HEIGHT : 52),
      onClick: () =>
        useTimelineStore
          .getState()
          .patchTrack(trackId, { height: track.kind === 'video' ? VIDEO_TRACK_HEIGHT : 52 }, 'Resize track'),
    },
    {
      label: 'Large',
      checked: track.height === LARGE_TRACK_HEIGHT,
      onClick: () => useTimelineStore.getState().patchTrack(trackId, { height: LARGE_TRACK_HEIGHT }, 'Resize track'),
    },
  ];

  return [
    {
      label: 'Add Video Track',
      icon: icon(<Video size={13} />),
      onClick: () => useTimelineStore.getState().addTrack('video'),
    },
    {
      label: 'Add Audio Track',
      icon: icon(<Music size={13} />),
      onClick: () => useTimelineStore.getState().addTrack('audio'),
    },
    { separator: true },
    { label: 'Rename Track…', icon: icon(<Pencil size={13} />), onClick: () => handlers.onRename(trackId) },
    {
      label: 'Move Track Up',
      icon: icon(<ArrowUp size={13} />),
      disabled: !canMoveUp,
      onClick: () => useTimelineStore.getState().reorderTrack(trackId, upDirection),
    },
    {
      label: 'Move Track Down',
      icon: icon(<ArrowDown size={13} />),
      disabled: !canMoveDown,
      onClick: () => useTimelineStore.getState().reorderTrack(trackId, downDirection),
    },
    { separator: true },
    {
      label: 'Track Height',
      icon: icon(<Rows3 size={13} />),
      submenu: heightItems,
    },
    { separator: true },
    {
      label: 'Delete Track',
      icon: icon(<Trash2 size={13} />),
      danger: true,
      disabled: !canDelete,
      onClick: () => useTimelineStore.getState().removeTrack(trackId),
    },
  ];
}

export interface TimelineMenuHandlers {
  onZoomToFit: () => void;
}

export function buildTimelineMenuItems(handlers: TimelineMenuHandlers): ContextMenuItem[] {
  const store = useTimelineStore.getState();
  return [
    {
      label: 'Paste',
      icon: icon(<Clipboard size={13} />),
      shortcut: 'Ctrl+V',
      disabled: store.clipboard.length === 0,
      onClick: () => useTimelineStore.getState().pasteAtPlayhead(),
    },
    { separator: true },
    {
      label: 'Add Marker at Playhead',
      icon: icon(<Flag size={13} />),
      shortcut: 'M',
      onClick: () => useTimelineStore.getState().addMarkerAtPlayhead(),
    },
    {
      label: 'Add Video Track',
      icon: icon(<Video size={13} />),
      onClick: () => useTimelineStore.getState().addTrack('video'),
    },
    {
      label: 'Add Audio Track',
      icon: icon(<Music size={13} />),
      onClick: () => useTimelineStore.getState().addTrack('audio'),
    },
    { separator: true },
    {
      label: 'Select All Clips',
      icon: icon(<MousePointer2 size={13} />),
      shortcut: 'Ctrl+A',
      onClick: () => useTimelineStore.getState().selectAllClips(),
    },
    {
      label: 'Zoom to Fit',
      icon: icon(<Maximize2 size={13} />),
      shortcut: '\\',
      onClick: () => handlers.onZoomToFit(),
    },
  ];
}

export interface MarkerMenuHandlers {
  onSeek: (frame: number) => void;
}

export function buildMarkerMenuItems(markerId: string, handlers: MarkerMenuHandlers): ContextMenuItem[] {
  const sequence = getActiveSequence();
  const marker: Marker | undefined = sequence?.markers.find((candidate) => candidate.id === markerId);
  if (!marker || !sequence) return [];
  return [
    {
      label: `Go to Marker (${frameToTimecode(marker.frame, sequence.frameRate)})`,
      icon: icon(<Flag size={13} />),
      onClick: () => handlers.onSeek(marker.frame),
    },
    { separator: true },
    {
      label: 'Add Marker at Playhead',
      icon: icon(<Plus size={13} />),
      shortcut: 'M',
      onClick: () => useTimelineStore.getState().addMarkerAtPlayhead(),
    },
    { separator: true },
    {
      label: 'Remove Marker',
      icon: icon(<Trash2 size={13} />),
      danger: true,
      onClick: () => useTimelineStore.getState().removeMarkerById(markerId),
    },
  ];
}

/** Exported for completeness: build track toggle labels consistently. */
export function trackToggleLabel(track: Track, patch: Partial<Track>): string {
  if ('locked' in patch) return patch.locked ? 'Lock track' : 'Unlock track';
  if ('hidden' in patch) return patch.hidden ? 'Hide video track' : 'Show video track';
  if ('muted' in patch) return patch.muted ? 'Mute audio track' : 'Unmute audio track';
  if ('solo' in patch) return patch.solo ? 'Solo audio track' : 'Unsolo audio track';
  if ('enabled' in patch) return patch.enabled ? 'Enable track' : 'Disable track';
  return `Update ${track.name}`;
}
