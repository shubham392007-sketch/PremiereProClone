/** Per-file import progress rows shown at the bottom of the Media panel. */
import { AlertTriangle, Check, X } from 'lucide-react';
import type { ImportProgressItem, ImportProgressSnapshot, ImportStage } from '@/services/media-import';
import { IconButton } from '@/components/common/IconButton';
import { Spinner } from '@/components/common/EmptyState';
import { cn } from '@/utils/format';
import { KindGlyph } from './MediaThumbnails';

const STAGE_LABELS: Record<ImportStage, string> = {
  queued: 'Waiting',
  probing: 'Reading metadata',
  thumbnail: 'Creating thumbnail',
  waveform: 'Analyzing audio',
  saving: 'Saving file',
  done: 'Imported',
  error: 'Failed',
  skipped: 'Skipped',
};

function statusLabel(item: ImportProgressItem): string {
  if (item.stage === 'error') return item.error ?? 'Failed';
  if (item.stage === 'skipped') return 'Duplicate file';
  if (item.stage === 'done') return item.detail ? `Imported · ${item.detail}` : 'Imported';
  return `${STAGE_LABELS[item.stage]}…`;
}

export function ImportProgressList({
  snapshot,
  onDismiss,
}: {
  snapshot: ImportProgressSnapshot;
  onDismiss: () => void;
}) {
  const total = snapshot.items.length;
  const finished = snapshot.items.filter(
    (item) => item.stage === 'done' || item.stage === 'error' || item.stage === 'skipped',
  ).length;
  const failed = snapshot.items.filter((item) => item.stage === 'error').length;

  return (
    <div
      data-testid="import-progress"
      className="shrink-0 border-t border-app-border bg-app-panel2 px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 pb-1">
        {snapshot.running ? (
          <Spinner size={10} />
        ) : failed > 0 ? (
          <AlertTriangle size={11} className="text-[#e5b75a]" />
        ) : (
          <Check size={11} className="text-app-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-2xs text-app-textDim">
          {snapshot.running
            ? `Importing ${Math.min(finished + 1, total)} of ${total}…`
            : `Import finished — ${finished} of ${total} file${total === 1 ? '' : 's'}`}
        </span>
        <span className="text-3xs text-app-textFaint">
          {finished}/{total}
        </span>
        {!snapshot.running ? (
          <IconButton icon={X} label="Dismiss import progress" size={18} iconSize={10} onClick={onDismiss} />
        ) : null}
      </div>
      <div className="flex max-h-[88px] flex-col gap-1 overflow-y-auto">
        {snapshot.items.map((item) => (
          <div key={item.id} className="flex min-h-[16px] items-center gap-1.5">
            <KindGlyph kind={item.kind} size={10} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-2xs text-app-textDim" title={item.fileName}>
              {item.fileName}
            </span>
            <span
              className={cn(
                'max-w-[46%] shrink-0 truncate text-3xs',
                item.stage === 'error' ? 'text-[#ff9b9b]' : 'text-app-textFaint',
              )}
              title={statusLabel(item)}
            >
              {statusLabel(item)}
            </span>
            <span className="h-[3px] w-14 shrink-0 overflow-hidden rounded-full bg-[#333333]">
              <span
                className={cn(
                  'block h-full rounded-full transition-[width] duration-150',
                  item.stage === 'error' ? 'bg-[#b05252]' : 'bg-app-accent',
                )}
                style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
