/** Phase-1 placeholder: effects are explicitly out of scope, no fake controls. */
import { Boxes } from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';

export function EffectsTab() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-app-border px-2 text-2xs uppercase tracking-wide text-app-textDim">
        Effects
      </div>
      <div className="min-h-0 flex-1">
        <EmptyState
          icon={Boxes}
          title="Effects and transitions arrive in Phase 2"
          description="Video effects, transitions, keyframing and effect controls are not implemented in this build. This panel intentionally contains no fake controls."
        />
      </div>
    </div>
  );
}
