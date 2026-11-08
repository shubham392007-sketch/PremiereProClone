/**
 * Development-only inspection hook. Used by the automated end-to-end test
 * harness to read authoritative editor state without scraping the DOM.
 * It is a no-op in production builds.
 */
import { useProjectStore, getActiveSequence } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { useMediaStore } from '@/stores/media-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { programPlayback, sourcePlayback } from '@/engine/playback/registry';
import { sequenceEndFrame } from '@/engine/timeline/operations';

export function installDebugHook(): void {
  if (!import.meta.env.DEV) return;
  const debug = {
    stores: {
      project: useProjectStore,
      timeline: useTimelineStore,
      playback: usePlaybackStore,
      media: useMediaStore,
      workspace: useWorkspaceStore,
    },
    getActiveSequence,
    sequenceEndFrame,
    programPlayback,
    sourcePlayback,
    snapshot() {
      const project = useProjectStore.getState().project;
      const sequence = getActiveSequence();
      return {
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        saveStatus: useProjectStore.getState().saveStatus,
        media: project?.media ?? [],
        sequence,
        currentFrame: usePlaybackStore.getState().currentFrame,
        isPlaying: usePlaybackStore.getState().isPlaying,
        selectedClipIds: useTimelineStore.getState().selectedClipIds,
        sequenceEnd: sequence ? sequenceEndFrame(sequence) : 0,
        urls: Object.keys(useMediaStore.getState().urls),
      };
    },
  };
  (window as unknown as { __PREMIERE_DEBUG__: typeof debug }).__PREMIERE_DEBUG__ = debug;
}
