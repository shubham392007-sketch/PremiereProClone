/** Undo / redo history backed by the project store's snapshot stacks. */
import { History, Redo2, Undo2 } from 'lucide-react';
import { useProjectStore } from '@/stores/project-store';
import { EmptyState } from '@/components/common/EmptyState';
import { cn } from '@/utils/format';

export function HistoryTab() {
  const past = useProjectStore((s) => s.past);
  const future = useProjectStore((s) => s.future);
  const undoLabel = useProjectStore((s) => s.undoLabel);
  const redoLabel = useProjectStore((s) => s.redoLabel);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const totalEntries = past.length + future.length;

  const undoToEntry = (index: number) => {
    const steps = past.length - index;
    for (let step = 0; step < steps; step++) useProjectStore.getState().undo();
  };

  const redoToEntry = (renderIndex: number) => {
    const steps = renderIndex + 1;
    for (let step = 0; step < steps; step++) useProjectStore.getState().redo();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-app-border px-1.5">
        <button
          type="button"
          className="btn h-6 gap-1 px-2 text-2xs"
          onClick={undo}
          disabled={past.length === 0}
          title={undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo'}
        >
          <Undo2 size={12} />
          Undo
        </button>
        <button
          type="button"
          className="btn h-6 gap-1 px-2 text-2xs"
          onClick={redo}
          disabled={future.length === 0}
          title={redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo'}
        >
          <Redo2 size={12} />
          Redo
        </button>
        <span className="ml-auto text-3xs text-app-textFaint">
          {past.length} undo · {future.length} redo
        </span>
      </div>
      {totalEntries === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={History}
            title="No edits yet"
            description="Edits you make in the editor appear here. Click an entry to return to that state."
          />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {past.map((entry, index) => (
              <button
                key={`past-${index}`}
                type="button"
                onClick={() => undoToEntry(index)}
                className="flex w-full items-center gap-2 px-2 py-[3px] text-left text-2xs text-app-textDim hover:bg-[#2a2a2a] hover:text-app-text"
                title={`Undo back to this state (${entry.label})`}
              >
                <span className="w-6 shrink-0 text-right font-mono text-3xs text-app-textFaint">{index + 1}</span>
                <span className="truncate">{entry.label}</span>
              </button>
            ))}
            <div className="flex items-center gap-2 border-y border-app-accent/50 bg-app-selection/40 px-2 py-[3px] text-2xs text-app-text">
              <span className="w-6 shrink-0 text-right font-mono text-3xs text-app-textDim">›</span>
              <span>Current state</span>
            </div>
            {[...future].reverse().map((entry, index) => (
              <button
                key={`future-${index}`}
                type="button"
                onClick={() => redoToEntry(index)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-[3px] text-left text-2xs text-app-textFaint hover:bg-[#2a2a2a] hover:text-app-textDim',
                )}
                title={`Redo to this state (${entry.label})`}
              >
                <span className="w-6 shrink-0 text-right font-mono text-3xs">+{index + 1}</span>
                <span className="truncate">{entry.label}</span>
              </button>
            ))}
          </div>
          <div className="shrink-0 border-t border-app-border px-2 py-1 text-3xs text-app-textFaint">
            Click an entry to jump to that state. History keeps up to 120 steps.
          </div>
        </>
      )}
    </div>
  );
}
