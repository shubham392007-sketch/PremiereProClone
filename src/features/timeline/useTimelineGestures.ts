import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { FrameRate, MediaAsset, Project, Sequence, TimelineClip, Track, TrackKind } from '@/types';
import { trimClipEnd, trimClipStart } from '@/engine/timeline/operations';
import { getActiveSequence } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { frameToPixels, framesToWidth, pixelsToFrame } from '@/utils/timeline-geometry';
import { clamp } from '@/utils/time';
import {
  DRAG_THRESHOLD_PX,
  EDGE_SCROLL_MAX_STEP,
  EDGE_SCROLL_PX,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  SNAP_THRESHOLD_PX,
} from './timeline-constants';
import {
  collectSnapFrames,
  findSnap,
  seekPlayhead,
  sourceMaxFrames,
  trackAtIndex,
  trackRowAtContentY,
  type TrackRow,
} from './timeline-helpers';

export type GestureKind = 'move' | 'trim-start' | 'trim-end' | 'playhead' | 'hand' | 'marquee' | 'track-height' | null;

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TimelineGestureArgs {
  sequence: Sequence;
  mediaMap: Map<string, MediaAsset>;
  rows: TrackRow[];
  fps: FrameRate;
  viewportRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  onScrollChanged: () => void;
  zoomByAt: (factor: number, clientX: number) => void;
  setTrackHeightPreview: (trackId: string, height: number | null) => void;
}

export interface TimelineGesturesApi {
  onClipPointerDown: (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip) => void;
  onClipDoubleClick: (event: ReactMouseEvent<HTMLElement>, clip: TimelineClip) => void;
  onTrimPointerDown: (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, edge: 'start' | 'end') => void;
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>, trackId: string) => void;
  onRulerPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onTrackResizePointerDown: (event: ReactPointerEvent<HTMLElement>, trackId: string) => void;
  snapLineFrame: number | null;
  marqueeRect: MarqueeRect | null;
  gestureKind: GestureKind;
}

/* ------------------------------------------------------------------ */
/* internal gesture state                                             */
/* ------------------------------------------------------------------ */

interface MoveOriginal {
  id: string;
  startFrame: number;
  durationFrames: number;
  trackId: string;
}

interface MoveGesture {
  kind: 'move';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  primaryId: string;
  primaryKind: TrackKind;
  primaryIndex: number;
  linked: { id: string; kind: TrackKind; index: number } | null;
  originals: MoveOriginal[];
  snapFrames: number[];
  before: Project | null;
  started: boolean;
}

interface TrimOriginal {
  id: string;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  playbackRate: number;
  isImage: boolean;
  maxSourceFrames: number;
}

interface TrimGesture {
  kind: 'trim-start' | 'trim-end';
  pointerId: number;
  startClientX: number;
  startScrollLeft: number;
  targets: TrimOriginal[];
  snapFrames: number[];
  before: Project;
}

interface HandGesture {
  kind: 'hand';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
}

interface PlayheadGesture {
  kind: 'playhead';
  pointerId: number;
}

interface MarqueeGesture {
  kind: 'marquee';
  pointerId: number;
  startContentX: number;
  startContentY: number;
  startClientX: number;
  startClientY: number;
  baseSelection: string[];
  additive: boolean;
  started: boolean;
}

interface TrackHeightGesture {
  kind: 'track-height';
  pointerId: number;
  trackId: string;
  startClientY: number;
  startHeight: number;
  currentHeight: number;
  changed: boolean;
}

type ActiveGesture =
  | MoveGesture
  | TrimGesture
  | HandGesture
  | PlayheadGesture
  | MarqueeGesture
  | TrackHeightGesture;

interface PointerPosition {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                        */
/* ------------------------------------------------------------------ */

function capturePointer(element: Element | null, pointerId: number): void {
  try {
    (element as HTMLElement | null)?.setPointerCapture?.(pointerId);
  } catch {
    /* pointer capture is best-effort */
  }
}

function releasePointer(element: Element | null, pointerId: number): void {
  try {
    (element as HTMLElement | null)?.releasePointerCapture?.(pointerId);
  } catch {
    /* ignore */
  }
}

function beginWindowSession(
  pointerId: number,
  pointerRef: MutableRefObject<PointerPosition>,
  onMove: () => void,
  onEnd: () => void,
): () => void {
  const handleMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (event.cancelable) event.preventDefault();
    onMove();
  };
  const handleEnd = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    cleanup();
    onEnd();
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleEnd);
    window.removeEventListener('pointercancel', handleEnd);
  };
  window.addEventListener('pointermove', handleMove, { passive: false });
  window.addEventListener('pointerup', handleEnd);
  window.addEventListener('pointercancel', handleEnd);
  return cleanup;
}

function startEdgeAutoScroll(options: {
  viewportRef: RefObject<HTMLDivElement>;
  pointer: MutableRefObject<PointerPosition>;
  isActive: () => boolean;
  update: () => void;
  onScroll: () => void;
}): () => void {
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!options.isActive()) return;
    const viewport = options.viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const pointer = options.pointer.current;
    let dx = 0;
    let dy = 0;
    if (pointer.x < rect.left + EDGE_SCROLL_PX) {
      dx = -Math.ceil(((rect.left + EDGE_SCROLL_PX - pointer.x) / EDGE_SCROLL_PX) * EDGE_SCROLL_MAX_STEP);
    } else if (pointer.x > rect.right - EDGE_SCROLL_PX) {
      dx = Math.ceil(((pointer.x - (rect.right - EDGE_SCROLL_PX)) / EDGE_SCROLL_PX) * EDGE_SCROLL_MAX_STEP);
    }
    if (pointer.y < rect.top + EDGE_SCROLL_PX) {
      dy = -Math.ceil(((rect.top + EDGE_SCROLL_PX - pointer.y) / EDGE_SCROLL_PX) * EDGE_SCROLL_MAX_STEP);
    } else if (pointer.y > rect.bottom - EDGE_SCROLL_PX) {
      dy = Math.ceil(((pointer.y - (rect.bottom - EDGE_SCROLL_PX)) / EDGE_SCROLL_PX) * EDGE_SCROLL_MAX_STEP);
    }
    if (!dx && !dy) return;
    const beforeLeft = viewport.scrollLeft;
    const beforeTop = viewport.scrollTop;
    viewport.scrollLeft = Math.max(0, viewport.scrollLeft + dx);
    viewport.scrollTop = Math.max(0, viewport.scrollTop + dy);
    if (viewport.scrollLeft === beforeLeft && viewport.scrollTop === beforeTop) return;
    options.onScroll();
    options.update();
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/* ------------------------------------------------------------------ */
/* hook                                                               */
/* ------------------------------------------------------------------ */

export function useTimelineGestures(args: TimelineGestureArgs): TimelineGesturesApi {
  const latestRef = useRef<TimelineGestureArgs>(args);
  latestRef.current = args;

  const pointerRef = useRef<PointerPosition>({ x: 0, y: 0 });
  const gestureRef = useRef<ActiveGesture | null>(null);
  const autoScrollStopRef = useRef<(() => void) | null>(null);

  const [snapLineFrame, setSnapLineFrame] = useState<number | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);
  const [gestureKind, setGestureKind] = useState<GestureKind>(null);

  const endSession = useCallback(() => {
    autoScrollStopRef.current?.();
    autoScrollStopRef.current = null;
    gestureRef.current = null;
    setGestureKind(null);
  }, []);

  useEffect(() => {
    return () => {
      autoScrollStopRef.current?.();
      autoScrollStopRef.current = null;
    };
  }, []);

  const beginAutoScroll = useCallback((isActive: () => boolean, update: () => void) => {
    autoScrollStopRef.current?.();
    autoScrollStopRef.current = startEdgeAutoScroll({
      viewportRef: latestRef.current.viewportRef,
      pointer: pointerRef,
      isActive,
      update,
      onScroll: () => latestRef.current.onScrollChanged(),
    });
  }, []);

  /* ---------------------------- move ---------------------------- */

  const applyMove = useCallback((gesture: MoveGesture) => {
    const viewport = latestRef.current.viewportRef.current;
    const content = latestRef.current.contentRef.current;
    const store = useTimelineStore.getState();
    if (!viewport || !content) return;
    const fps = latestRef.current.fps;
    const zoom = store.zoomPixelsPerSecond;
    const pointer = pointerRef.current;

    let deltaFrames = pixelsToFrame(
      pointer.x - gesture.startClientX + (viewport.scrollLeft - gesture.startScrollLeft),
      fps,
      zoom,
    );
    const minStart = Math.min(...gesture.originals.map((original) => original.startFrame));
    if (deltaFrames < -minStart) deltaFrames = -minStart;

    let snapFrame: number | null = null;
    if (store.snapping) {
      const candidates: number[] = [];
      for (const original of gesture.originals) {
        candidates.push(original.startFrame + deltaFrames);
        candidates.push(original.startFrame + original.durationFrames + deltaFrames);
      }
      const snap = findSnap(candidates, gesture.snapFrames, fps, zoom, SNAP_THRESHOLD_PX);
      if (snap) {
        deltaFrames += snap.deltaFrames;
        if (deltaFrames < -minStart) deltaFrames = -minStart;
        snapFrame = snap.snapFrame;
      }
    }

    // Vertical track change: only for a single clip or a linked pair.
    const allowVertical = gesture.originals.length === 1 || (gesture.linked !== null && gesture.originals.length === 2);
    let primaryTargetTrackId: string | null = null;
    let linkedTargetTrackId: string | null = null;
    if (allowVertical) {
      const contentRect = content.getBoundingClientRect();
      const row = trackRowAtContentY(latestRef.current.rows, pointer.y - contentRect.top);
      const sequence = getActiveSequence();
      if (row && sequence && !row.track.locked && row.track.kind === gesture.primaryKind) {
        const deltaIndex = row.track.index - gesture.primaryIndex;
        if (deltaIndex !== 0) {
          primaryTargetTrackId = row.track.id;
          if (gesture.linked) {
            const target = trackAtIndex(sequence, gesture.linked.kind, gesture.linked.index + deltaIndex);
            if (target && !target.locked) linkedTargetTrackId = target.id;
          }
        }
      }
    }

    store.liveEdit((draft) => {
      for (const original of gesture.originals) {
        const clip = draft.clips.find((candidate) => candidate.id === original.id);
        if (!clip) continue;
        clip.startFrame = Math.max(0, original.startFrame + deltaFrames);
        if (original.id === gesture.primaryId && primaryTargetTrackId) {
          clip.trackId = primaryTargetTrackId;
        } else if (gesture.linked && original.id === gesture.linked.id && linkedTargetTrackId) {
          clip.trackId = linkedTargetTrackId;
        }
      }
    });
    setSnapLineFrame(snapFrame);
  }, []);

  const beginMoveGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      clip: TimelineClip,
      track: Track,
      sequence: Sequence,
    ) => {
      const selected = useTimelineStore.getState().selectedClipIds;
      const clipsById = new Map(sequence.clips.map((item) => [item.id, item]));
      const tracksById = new Map(sequence.tracks.map((item) => [item.id, item]));

      const linkedClipId = clip.linkedClipId ?? sequence.clips.find((item) => item.linkedClipId === clip.id)?.id ?? null;
      const originals: MoveOriginal[] = [];
      const addOriginal = (id: string) => {
        if (originals.some((original) => original.id === id)) return;
        const candidate = clipsById.get(id);
        if (!candidate) return;
        const candidateTrack = tracksById.get(candidate.trackId);
        if (!candidateTrack || candidateTrack.locked) return;
        originals.push({
          id: candidate.id,
          startFrame: candidate.startFrame,
          durationFrames: candidate.durationFrames,
          trackId: candidate.trackId,
        });
      };
      addOriginal(clip.id);
      if (linkedClipId) addOriginal(linkedClipId);
      for (const id of selected) addOriginal(id);

      let linked: MoveGesture['linked'] = null;
      if (linkedClipId && originals.some((original) => original.id === linkedClipId)) {
        const linkedClip = clipsById.get(linkedClipId);
        const linkedTrack = linkedClip ? tracksById.get(linkedClip.trackId) : undefined;
        if (linkedClip && linkedTrack) {
          linked = { id: linkedClip.id, kind: linkedTrack.kind, index: linkedTrack.index };
        }
      }

      const gesture: MoveGesture = {
        kind: 'move',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: latestRef.current.viewportRef.current?.scrollLeft ?? 0,
        primaryId: clip.id,
        primaryKind: track.kind,
        primaryIndex: track.index,
        linked,
        originals,
        snapFrames: collectSnapFrames(sequence, new Set(originals.map((original) => original.id))),
        before: null,
        started: false,
      };
      gestureRef.current = gesture;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      capturePointer(event.currentTarget, event.pointerId);
      const sourceElement = event.currentTarget;
      const update = () => {
        if (gestureRef.current !== gesture) return;
        if (!gesture.started) {
          const distance =
            Math.abs(pointerRef.current.x - gesture.startClientX) +
            Math.abs(pointerRef.current.y - gesture.startClientY);
          if (distance < DRAG_THRESHOLD_PX) return;
          gesture.started = true;
          gesture.before = useTimelineStore.getState().beginEdit();
          useTimelineStore.getState().setInteracting(true);
          setGestureKind('move');
          beginAutoScroll(
            () => gestureRef.current === gesture && gesture.started,
            () => applyMove(gesture),
          );
        }
        applyMove(gesture);
      };
      beginWindowSession(
        event.pointerId,
        pointerRef,
        update,
        () => {
          releasePointer(sourceElement, event.pointerId);
          if (gestureRef.current === gesture) {
            if (gesture.started && gesture.before) {
              useTimelineStore
                .getState()
                .endEdit(gesture.before, gesture.originals.length > 1 ? 'Move clips' : 'Move clip');
            }
            useTimelineStore.getState().setInteracting(false);
            setSnapLineFrame(null);
          }
          endSession();
        },
      );
    },
    [applyMove, beginAutoScroll, endSession],
  );

  /* ---------------------------- trim ---------------------------- */

  const applyTrim = useCallback((gesture: TrimGesture) => {
    const viewport = latestRef.current.viewportRef.current;
    const store = useTimelineStore.getState();
    if (!viewport) return;
    const fps = latestRef.current.fps;
    const zoom = store.zoomPixelsPerSecond;
    const pointer = pointerRef.current;
    const primary = gesture.targets[0];
    if (!primary) return;

    let deltaFrames = pixelsToFrame(
      pointer.x - gesture.startClientX + (viewport.scrollLeft - gesture.startScrollLeft),
      fps,
      zoom,
    );
    let snapFrame: number | null = null;

    if (gesture.kind === 'trim-start') {
      let desiredStart = primary.startFrame + deltaFrames;
      if (store.snapping) {
        const snap = findSnap([desiredStart], gesture.snapFrames, fps, zoom, SNAP_THRESHOLD_PX);
        if (snap) {
          desiredStart = snap.snapFrame;
          snapFrame = snap.snapFrame;
        }
      }
      deltaFrames = Math.round(desiredStart - primary.startFrame);
      store.liveEdit((draft) => {
        for (const target of gesture.targets) {
          trimClipStart(draft, target.id, target.startFrame + deltaFrames, { allowSourcePreRoll: target.isImage });
        }
      });
    } else {
      const primaryEnd = primary.startFrame + primary.durationFrames;
      let desiredEnd = primaryEnd + deltaFrames;
      if (store.snapping) {
        const snap = findSnap([desiredEnd], gesture.snapFrames, fps, zoom, SNAP_THRESHOLD_PX);
        if (snap) {
          desiredEnd = snap.snapFrame;
          snapFrame = snap.snapFrame;
        }
      }
      deltaFrames = Math.round(desiredEnd - primaryEnd);
      store.liveEdit((draft) => {
        for (const target of gesture.targets) {
          const desiredTargetEnd = target.startFrame + target.durationFrames + deltaFrames;
          if (target.isImage || target.maxSourceFrames === Number.MAX_SAFE_INTEGER) {
            trimClipEnd(draft, target.id, desiredTargetEnd);
          } else {
            const availableSourceFrames = Math.max(
              0,
              target.maxSourceFrames - target.sourceInFrame - target.durationFrames * target.playbackRate,
            );
            const maxEndFrame =
              target.startFrame + target.durationFrames + Math.floor(availableSourceFrames / Math.max(0.01, target.playbackRate));
            trimClipEnd(draft, target.id, desiredTargetEnd, { maxEndFrame });
          }
        }
      });
    }
    setSnapLineFrame(snapFrame);
  }, []);

  const onTrimPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, edge: 'start' | 'end') => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const sequence = getActiveSequence();
      if (!sequence) return;
      const track = sequence.tracks.find((item) => item.id === clip.trackId);
      if (!track || track.locked) return;

      const mediaMap = latestRef.current.mediaMap;
      const ids = new Set<string>([clip.id]);
      const linkedClipId = clip.linkedClipId ?? sequence.clips.find((item) => item.linkedClipId === clip.id)?.id ?? null;
      if (linkedClipId) ids.add(linkedClipId);

      const targets: TrimOriginal[] = [];
      const ordered = [clip.id, ...[...ids].filter((id) => id !== clip.id)];
      for (const id of ordered) {
        const candidate = sequence.clips.find((item) => item.id === id);
        if (!candidate) continue;
        const candidateTrack = sequence.tracks.find((item) => item.id === candidate.trackId);
        if (!candidateTrack || candidateTrack.locked) continue;
        const media = mediaMap.get(candidate.mediaId);
        targets.push({
          id: candidate.id,
          startFrame: candidate.startFrame,
          durationFrames: candidate.durationFrames,
          sourceInFrame: candidate.sourceInFrame,
          playbackRate: candidate.playbackRate,
          isImage: media?.kind === 'image',
          maxSourceFrames: sourceMaxFrames(media, sequence.frameRate),
        });
      }
      if (!targets.length) return;

      const before = useTimelineStore.getState().beginEdit();
      if (!before) return;

      const gesture: TrimGesture = {
        kind: edge === 'start' ? 'trim-start' : 'trim-end',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startScrollLeft: latestRef.current.viewportRef.current?.scrollLeft ?? 0,
        targets,
        snapFrames: collectSnapFrames(sequence, new Set(targets.map((target) => target.id))),
        before,
      };
      gestureRef.current = gesture;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      setGestureKind(gesture.kind);
      useTimelineStore.getState().setInteracting(true);
      capturePointer(event.currentTarget, event.pointerId);
      const sourceElement = event.currentTarget;
      beginAutoScroll(
        () => gestureRef.current === gesture,
        () => applyTrim(gesture),
      );
      beginWindowSession(
        event.pointerId,
        pointerRef,
        () => {
          if (gestureRef.current === gesture) applyTrim(gesture);
        },
        () => {
          releasePointer(sourceElement, event.pointerId);
          if (gestureRef.current === gesture) {
            applyTrim(gesture);
            useTimelineStore
              .getState()
              .endEdit(gesture.before, gesture.kind === 'trim-start' ? 'Trim clip start' : 'Trim clip end');
            useTimelineStore.getState().setInteracting(false);
            setSnapLineFrame(null);
          }
          endSession();
        },
      );
    },
    [applyTrim, beginAutoScroll, endSession],
  );

  /* ---------------------------- hand ---------------------------- */

  const beginHandGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const viewport = latestRef.current.viewportRef.current;
      if (!viewport) return;
      event.preventDefault();
      event.stopPropagation();
      const gesture: HandGesture = {
        kind: 'hand',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: viewport.scrollLeft,
        startScrollTop: viewport.scrollTop,
      };
      gestureRef.current = gesture;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      setGestureKind('hand');
      capturePointer(event.currentTarget, event.pointerId);
      const sourceElement = event.currentTarget;
      beginWindowSession(
        event.pointerId,
        pointerRef,
        () => {
          if (gestureRef.current !== gesture) return;
          viewport.scrollLeft = Math.max(0, gesture.startScrollLeft - (pointerRef.current.x - gesture.startClientX));
          viewport.scrollTop = Math.max(0, gesture.startScrollTop - (pointerRef.current.y - gesture.startClientY));
          latestRef.current.onScrollChanged();
        },
        () => {
          releasePointer(sourceElement, event.pointerId);
          endSession();
        },
      );
    },
    [endSession],
  );

  /* ------------------------ clip pointer ------------------------ */

  const onClipPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip) => {
      if (event.button === 2) return;
      event.stopPropagation();
      event.preventDefault();
      const store = useTimelineStore.getState();
      const sequence = getActiveSequence();
      const track = sequence?.tracks.find((item) => item.id === clip.trackId);
      if (!sequence || !track) return;

      if (event.button === 1) {
        beginHandGesture(event);
        return;
      }
      if (event.button !== 0) return;

      if (store.tool === 'razor') {
        const frame = latestRef.current.contentRef.current
          ? clamp(
              pixelsToFrame(
                event.clientX - latestRef.current.contentRef.current.getBoundingClientRect().left,
                latestRef.current.fps,
                store.zoomPixelsPerSecond,
              ),
              0,
              Number.MAX_SAFE_INTEGER,
            )
          : 0;
        store.splitClipAt(clip.id, Math.max(0, Math.round(frame)));
        return;
      }
      if (store.tool === 'hand') {
        beginHandGesture(event);
        return;
      }
      if (store.tool === 'zoom') {
        latestRef.current.zoomByAt(event.altKey ? 1 / 1.6 : 1.6, event.clientX);
        return;
      }

      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const alreadySelected = store.selectedClipIds.includes(clip.id);
      if (additive) {
        if (alreadySelected) {
          store.selectClips([clip.id], 'toggle');
          return;
        }
        store.selectClips([clip.id], 'add');
      } else if (!alreadySelected) {
        store.selectClips([clip.id], 'replace');
      }
      if (track.locked) return;
      beginMoveGesture(event, clip, track, sequence);
    },
    [beginHandGesture, beginMoveGesture],
  );

  const onClipDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>, clip: TimelineClip) => {
    event.preventDefault();
    event.stopPropagation();
    const content = latestRef.current.contentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const zoom = useTimelineStore.getState().zoomPixelsPerSecond;
    const frame = Math.max(0, pixelsToFrame(event.clientX - rect.left, latestRef.current.fps, zoom));
    seekPlayhead(frame);
    useTimelineStore.getState().selectClips([clip.id], 'replace');
  }, []);

  /* ------------------------ lane pointer ------------------------ */

  const selectClipsInMarquee = useCallback((gesture: MarqueeGesture, endX: number, endY: number) => {
    const sequence = getActiveSequence();
    if (!sequence) return;
    const rows = latestRef.current.rows;
    const fps = latestRef.current.fps;
    const zoom = useTimelineStore.getState().zoomPixelsPerSecond;
    const left = Math.min(gesture.startContentX, endX);
    const right = Math.max(gesture.startContentX, endX);
    const top = Math.min(gesture.startContentY, endY);
    const bottom = Math.max(gesture.startContentY, endY);
    const ids: string[] = [];
    for (const clip of sequence.clips) {
      const row = rows.find((candidate) => candidate.track.id === clip.trackId);
      if (!row) continue;
      const clipLeft = frameToPixels(clip.startFrame, fps, zoom);
      const clipRight = clipLeft + Math.max(2, framesToWidth(clip.durationFrames, fps, zoom));
      const clipTop = row.top + 2;
      const clipBottom = row.top + row.height - 2;
      if (clipRight >= left && clipLeft <= right && clipBottom >= top && clipTop <= bottom) ids.push(clip.id);
    }
    const store = useTimelineStore.getState();
    if (gesture.additive) store.selectClips(ids, 'add');
    else store.selectClips(ids, 'replace');
  }, []);

  const onLanePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, trackId: string) => {
      if (event.button === 1) {
        beginHandGesture(event);
        return;
      }
      if (event.button !== 0) return;
      event.preventDefault();
      const store = useTimelineStore.getState();
      if (store.tool === 'hand') {
        beginHandGesture(event);
        return;
      }
      if (store.tool === 'zoom') {
        latestRef.current.zoomByAt(event.altKey ? 1 / 1.6 : 1.6, event.clientX);
        return;
      }
      if (store.tool === 'razor') return;

      const content = latestRef.current.contentRef.current;
      if (!content) return;
      const contentRect = content.getBoundingClientRect();
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const baseSelection = useTimelineStore.getState().selectedClipIds;
      if (!additive) store.clearSelection();
      store.selectTrack(trackId);

      const gesture: MarqueeGesture = {
        kind: 'marquee',
        pointerId: event.pointerId,
        startContentX: event.clientX - contentRect.left,
        startContentY: event.clientY - contentRect.top,
        startClientX: event.clientX,
        startClientY: event.clientY,
        baseSelection,
        additive,
        started: false,
      };
      gestureRef.current = gesture;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      capturePointer(event.currentTarget, event.pointerId);
      const sourceElement = event.currentTarget;
      const contentElement = content;
      const updateMarquee = () => {
        if (gestureRef.current !== gesture) return;
        const rect = contentElement.getBoundingClientRect();
        if (!gesture.started) {
          const distance =
            Math.abs(pointerRef.current.x - gesture.startClientX) +
            Math.abs(pointerRef.current.y - gesture.startClientY);
          if (distance < DRAG_THRESHOLD_PX) return;
          gesture.started = true;
          setGestureKind('marquee');
        }
        const x = pointerRef.current.x - rect.left;
        const y = pointerRef.current.y - rect.top;
        const left = Math.min(gesture.startContentX, x);
        const top = Math.min(gesture.startContentY, y);
        setMarqueeRect({
          left,
          top,
          width: Math.abs(x - gesture.startContentX),
          height: Math.abs(y - gesture.startContentY),
        });
      };
      beginAutoScroll(
        () => gestureRef.current === gesture,
        updateMarquee,
      );
      beginWindowSession(
        event.pointerId,
        pointerRef,
        updateMarquee,
        () => {
          releasePointer(sourceElement, event.pointerId);
          if (gestureRef.current === gesture && gesture.started) {
            const rect = contentElement.getBoundingClientRect();
            selectClipsInMarquee(
              gesture,
              pointerRef.current.x - rect.left,
              pointerRef.current.y - rect.top,
            );
          }
          setMarqueeRect(null);
          endSession();
        },
      );
    },
    [beginAutoScroll, beginHandGesture, endSession, selectClipsInMarquee],
  );

  /* ------------------------ ruler pointer ------------------------ */

  const onRulerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const viewport = latestRef.current.viewportRef.current;
      if (!viewport) return;
      const sequence = getActiveSequence();
      const snapFrames = collectSnapFrames(sequence);
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const seek = () => {
        const store = useTimelineStore.getState();
        const fps = latestRef.current.fps;
        const zoom = store.zoomPixelsPerSecond;
        const rect = viewport.getBoundingClientRect();
        let frame = Math.max(
          0,
          pixelsToFrame(viewport.scrollLeft + (pointerRef.current.x - rect.left), fps, zoom),
        );
        if (store.snapping) {
          const snap = findSnap([frame], snapFrames, fps, zoom, SNAP_THRESHOLD_PX);
          if (snap) {
            frame = snap.snapFrame;
            setSnapLineFrame(frame);
          } else {
            setSnapLineFrame(null);
          }
        }
        seekPlayhead(frame);
      };
      const gesture: PlayheadGesture = { kind: 'playhead', pointerId: event.pointerId };
      gestureRef.current = gesture;
      setGestureKind('playhead');
      seek();
      capturePointer(event.currentTarget, event.pointerId);
      const sourceElement = event.currentTarget;
      beginWindowSession(
        event.pointerId,
        pointerRef,
        seek,
        () => {
          releasePointer(sourceElement, event.pointerId);
          setSnapLineFrame(null);
          endSession();
        },
      );
    },
    [endSession],
  );

  /* ------------------------ track resize ------------------------ */

  const onTrackResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, trackId: string) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const row = latestRef.current.rows.find((candidate) => candidate.track.id === trackId);
      if (!row) return;
      const gesture: TrackHeightGesture = {
        kind: 'track-height',
        pointerId: event.pointerId,
        trackId,
        startClientY: event.clientY,
        startHeight: row.height,
        currentHeight: row.height,
        changed: false,
      };
      gestureRef.current = gesture;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      setGestureKind('track-height');
      capturePointer(event.currentTarget, event.pointerId);
      const sourceElement = event.currentTarget;
      beginWindowSession(
        event.pointerId,
        pointerRef,
        () => {
          if (gestureRef.current !== gesture) return;
          const height = clamp(
            gesture.startHeight + (pointerRef.current.y - gesture.startClientY),
            MIN_TRACK_HEIGHT,
            MAX_TRACK_HEIGHT,
          );
          gesture.currentHeight = height;
          gesture.changed = Math.abs(height - gesture.startHeight) >= 1;
          latestRef.current.setTrackHeightPreview(trackId, gesture.changed ? height : null);
        },
        () => {
          releasePointer(sourceElement, event.pointerId);
          latestRef.current.setTrackHeightPreview(trackId, null);
          if (gesture.changed) {
            useTimelineStore.getState().patchTrack(trackId, { height: gesture.currentHeight }, 'Resize track');
          }
          endSession();
        },
      );
    },
    [endSession],
  );

  return {
    onClipPointerDown,
    onClipDoubleClick,
    onTrimPointerDown,
    onLanePointerDown,
    onRulerPointerDown,
    onTrackResizePointerDown,
    snapLineFrame,
    marqueeRect,
    gestureKind,
  };
}
