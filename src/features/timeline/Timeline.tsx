import { useMemo, useRef } from 'react';
import { Clapperboard } from 'lucide-react';
import type { MediaAsset } from '@/types';
import { EmptyState } from '@/components/common/EmptyState';
import { useProjectStore } from '@/stores/project-store';
import { findSequence } from '@/engine/timeline/factory';
import { sequenceEndFrame } from '@/engine/timeline/operations';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineBody, type TimelineBodyHandle } from './TimelineBody';

/**
 * Media lookup map with a stable identity across project edits: every edit
 * clones the project, but the set of media rarely changes, so clips can keep
 * their memoisation.
 */
function useMediaMap(media: MediaAsset[] | undefined): Map<string, MediaAsset> {
  const cacheRef = useRef<{ signature: string; map: Map<string, MediaAsset> } | null>(null);
  const signature = (media ?? [])
    .map(
      (item) =>
        `${item.id}|${item.missing ? 1 : 0}|${item.thumbnailDataUrl ? 1 : 0}|${item.kind}|${item.name}|${
          item.hasAudio ? 1 : 0
        }`,
    )
    .join('~');

  if (!cacheRef.current || cacheRef.current.signature !== signature) {
    const map = new Map<string, MediaAsset>();
    for (const item of media ?? []) map.set(item.id, item);
    cacheRef.current = { signature, map };
  }
  return cacheRef.current.map;
}

/**
 * Professional multitrack timeline panel. Reads the active sequence and media
 * from the project/timeline stores, so it is mounted with no props.
 */
export function Timeline() {
  const project = useProjectStore((state) => state.project);
  const sequence = useMemo(() => (project ? findSequence(project) ?? project.sequences[0] ?? null : null), [project]);
  const mediaMap = useMediaMap(project?.media);
  const bodyRef = useRef<TimelineBodyHandle>(null);

  const durationFrames = useMemo(() => (sequence ? sequenceEndFrame(sequence) : 0), [sequence]);

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-t border-app-border bg-[#1c1c1c] text-app-text"
      aria-label="Timeline"
    >
      <TimelineToolbar fps={sequence?.frameRate ?? null} durationFrames={durationFrames} bodyRef={bodyRef} />
      {sequence ? (
        <TimelineBody ref={bodyRef} sequence={sequence} mediaMap={mediaMap} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={Clapperboard}
            title="No sequence open"
            description="Create or open a project with a sequence to start editing on the timeline."
          />
        </div>
      )}
    </section>
  );
}

export default Timeline;
