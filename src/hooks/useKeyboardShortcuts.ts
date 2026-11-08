import { useEffect } from 'react';
import { usePlaybackStore } from '@/stores/playback-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useProjectStore, getActiveSequence } from '@/stores/project-store';
import { useWorkspaceStore, notify } from '@/stores/workspace-store';
import { programPlayback, sourcePlayback } from '@/engine/playback/registry';
import { sequenceEndFrame } from '@/engine/timeline/operations';

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest?.('[data-shortcuts-ignore="true"]'));
}

function anyDialogOpen(): boolean {
  return Object.values(useWorkspaceStore.getState().dialogs).some(Boolean);
}

function zoomToFitTimeline(): void {
  const viewport =
    (document.querySelector('[data-timeline-viewport]') as HTMLElement | null)?.clientWidth ??
    Math.max(600, window.innerWidth * 0.72);
  useTimelineStore.getState().zoomToFit(viewport);
}

/**
 * Central keyboard shortcut manager for the editing workspace. Text inputs,
 * selects, contenteditable fields and open dialogs are excluded.
 */
export function useKeyboardShortcuts(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (anyDialogOpen()) return;
      if (!useProjectStore.getState().project) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key;
      const lower = key.toLowerCase();
      const code = e.code;
      const timeline = useTimelineStore.getState();
      const playback = usePlaybackStore.getState();

      const prevent = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // ---- modifier combinations ----
      if (ctrl) {
        switch (lower) {
          case 'z':
            prevent();
            if (e.shiftKey) useProjectStore.getState().redo();
            else useProjectStore.getState().undo();
            return;
          case 'y':
            prevent();
            useProjectStore.getState().redo();
            return;
          case 's':
            prevent();
            void useProjectStore.getState().saveNow();
            return;
          case 'c':
            prevent();
            timeline.copySelection();
            return;
          case 'x':
            prevent();
            timeline.cutSelection();
            return;
          case 'v':
            prevent();
            timeline.pasteAtPlayhead();
            return;
          case 'a':
            prevent();
            timeline.selectAllClips();
            return;
          case 'd':
            prevent();
            timeline.duplicateSelection();
            return;
          case 'k':
            prevent();
            timeline.splitAtPlayhead(e.shiftKey);
            return;
          case 'e':
            prevent();
            useWorkspaceStore.getState().openDialog('export');
            return;
          default:
            return;
        }
      }

      if (e.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        prevent();
        timeline.nudgeSelection(key === 'ArrowLeft' ? -1 : 1);
        return;
      }

      switch (code) {
        case 'Space':
          prevent();
          if (sourcePlayback.isReady() && usePlaybackStore.getState().source.mediaId) {
            // If the source monitor has focus context, only toggle source when its panel is active.
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl?.closest('[data-monitor="source"]')) {
              sourcePlayback.toggle();
              return;
            }
          }
          programPlayback.toggle();
          return;
        case 'ArrowLeft':
          prevent();
          programPlayback.step(-1);
          return;
        case 'ArrowRight':
          prevent();
          programPlayback.step(1);
          return;
        case 'Home':
          prevent();
          programPlayback.jumpToStart();
          return;
        case 'End': {
          prevent();
          const sequence = getActiveSequence();
          if (sequence) {
            const end = Math.max(0, sequenceEndFrame(sequence) - (e.shiftKey ? 0 : 1));
            programPlayback.seek(end);
          } else {
            programPlayback.jumpToEnd();
          }
          return;
        }
        case 'Delete':
        case 'Backspace':
          prevent();
          timeline.deleteSelection();
          return;
        case 'Escape':
          timeline.clearSelection();
          return;
        case 'Equal':
        case 'NumpadAdd':
          prevent();
          timeline.zoomIn();
          return;
        case 'Minus':
        case 'NumpadSubtract':
          prevent();
          timeline.zoomOut();
          return;
        case 'Backslash':
          prevent();
          zoomToFitTimeline();
          return;
        case 'KeyM':
          prevent();
          timeline.addMarkerAtPlayhead();
          notify('success', 'Marker added at playhead', undefined, 1600);
          return;
        default:
          break;
      }

      if (e.shiftKey || e.altKey) return;

      switch (lower) {
        case 'v':
          timeline.setTool('select');
          return;
        case 'c':
          timeline.setTool('razor');
          return;
        case 'h':
          timeline.setTool('hand');
          return;
        case 'z':
          timeline.setTool('zoom');
          return;
        case 'j': {
          const nextRate = playback.isPlaying && playback.rate < 0 ? Math.max(-4, playback.rate - 1) : -1;
          playback.setRate(nextRate);
          if (!playback.isPlaying) programPlayback.play();
          return;
        }
        case 'k':
          programPlayback.pause();
          playback.setRate(1);
          return;
        case 'l': {
          const nextRate = playback.isPlaying && playback.rate > 0 ? Math.min(4, playback.rate + 1) : 1;
          playback.setRate(nextRate);
          if (!playback.isPlaying) programPlayback.play();
          return;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
