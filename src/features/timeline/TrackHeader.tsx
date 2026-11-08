import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AudioLines, Eye, EyeOff, Film, Headphones, Lock, Power, Unlock, Volume2, VolumeX } from 'lucide-react';
import type { Track, TrackKind } from '@/types';
import { cn } from '@/utils/format';
import { HEADER_WIDTH } from './timeline-constants';

export interface TrackHeaderProps {
  trackId: string;
  kind: TrackKind;
  name: string;
  height: number;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  solo: boolean;
  enabled: boolean;
  selected: boolean;
  renaming: boolean;
  clipCount: number;
  onSelect: (trackId: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, trackId: string) => void;
  onToggle: (trackId: string, patch: Partial<Track>, label: string) => void;
  onStartRename: (trackId: string) => void;
  onRenameCommit: (trackId: string, name: string) => void;
  onRenameCancel: () => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLElement>, trackId: string) => void;
}

interface MiniToggleProps {
  icon: typeof Eye;
  title: string;
  active?: boolean;
  activeTone?: 'accent' | 'warning';
  onClick: () => void;
}

function MiniToggle({ icon: Icon, title, active, activeTone = 'warning', onClick }: MiniToggleProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex h-[15px] w-[17px] shrink-0 items-center justify-center rounded-[2px] text-app-textFaint transition-colors hover:bg-[#3a3a3a] hover:text-app-text',
        active && (activeTone === 'accent' ? 'bg-app-selection text-white' : 'text-[#e8c15a]'),
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon size={10} strokeWidth={2} />
    </button>
  );
}

/**
 * Fixed-width track header: name (inline rename), kind icon, per-kind toggles,
 * selection and a bottom drag handle to resize the track height.
 */
export const TrackHeader = memo(function TrackHeader({
  trackId,
  kind,
  name,
  height,
  locked,
  muted,
  hidden,
  solo,
  enabled,
  selected,
  renaming,
  clipCount,
  onSelect,
  onContextMenu,
  onToggle,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onResizePointerDown,
}: TrackHeaderProps) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(name);
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [renaming, name]);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRenameCommit(trackId, trimmed);
    else onRenameCancel();
  };

  return (
    <div
      className={cn(
        'group/header relative flex shrink-0 select-none flex-col justify-between overflow-hidden border-b border-[#2e2e2e] px-1.5 pt-0.5',
        selected ? 'bg-[#2a3340]' : 'bg-[#242424] hover:bg-[#282828]',
      )}
      style={{ height, width: HEADER_WIDTH }}
      title={`${name}${clipCount ? ` · ${clipCount} clip${clipCount === 1 ? '' : 's'}` : ''}${locked ? ' · Locked' : ''}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(trackId);
      }}
      onContextMenu={(event) => onContextMenu(event, trackId)}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-[2px] bg-app-accent" /> : null}

      <div className="flex min-w-0 items-center gap-1">
        <span className={cn('shrink-0', locked ? 'text-app-textFaint' : 'text-app-textDim')}>
          {kind === 'video' ? <Film size={10} strokeWidth={2} /> : <AudioLines size={10} strokeWidth={2} />}
        </span>
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            className="h-4 min-w-0 flex-1 rounded-[2px] border border-app-accent bg-[#191919] px-1 text-[10px] text-app-text outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onRenameCancel();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[10px] font-medium text-app-text/90 hover:text-app-text"
            title={`${name} — double-click to rename`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onStartRename(trackId);
            }}
          >
            {name}
          </button>
        )}
      </div>

      <div className="flex items-center gap-0.5 pb-[7px]">
        <MiniToggle
          icon={Power}
          title={`${enabled ? 'Disable' : 'Enable'} ${kind} track`}
          active={!enabled}
          activeTone="warning"
          onClick={() => onToggle(trackId, { enabled: !enabled }, `${enabled ? 'Disable' : 'Enable'} track`)}
        />
        {kind === 'video' ? (
          <MiniToggle
            icon={hidden ? EyeOff : Eye}
            title={hidden ? 'Show video track' : 'Hide video track'}
            active={hidden}
            onClick={() => onToggle(trackId, { hidden: !hidden }, `${hidden ? 'Show' : 'Hide'} video track`)}
          />
        ) : (
          <>
            <MiniToggle
              icon={muted ? VolumeX : Volume2}
              title={muted ? 'Unmute audio track' : 'Mute audio track'}
              active={muted}
              onClick={() => onToggle(trackId, { muted: !muted }, `${muted ? 'Unmute' : 'Mute'} audio track`)}
            />
            <MiniToggle
              icon={Headphones}
              title={solo ? 'Unsolo audio track' : 'Solo audio track'}
              active={solo}
              activeTone="accent"
              onClick={() => onToggle(trackId, { solo: !solo }, `${solo ? 'Unsolo' : 'Solo'} audio track`)}
            />
          </>
        )}
        <MiniToggle
          icon={locked ? Lock : Unlock}
          title={locked ? 'Unlock track' : 'Lock track'}
          active={locked}
          onClick={() => onToggle(trackId, { locked: !locked }, `${locked ? 'Unlock' : 'Lock'} track`)}
        />
      </div>

      <div
        className="absolute inset-x-0 bottom-0 z-10 flex h-[6px] cursor-row-resize items-center justify-center"
        title="Drag to resize track height"
        onPointerDown={(event) => {
          event.stopPropagation();
          onResizePointerDown(event, trackId);
        }}
      >
        <span className="h-[2px] w-10 rounded-full bg-transparent group-hover/header:bg-[#4d4d4d]" />
      </div>
    </div>
  );
}, areHeaderPropsEqual);

function areHeaderPropsEqual(previous: TrackHeaderProps, next: TrackHeaderProps): boolean {
  return (
    previous.trackId === next.trackId &&
    previous.kind === next.kind &&
    previous.name === next.name &&
    previous.height === next.height &&
    previous.locked === next.locked &&
    previous.muted === next.muted &&
    previous.hidden === next.hidden &&
    previous.solo === next.solo &&
    previous.enabled === next.enabled &&
    previous.selected === next.selected &&
    previous.renaming === next.renaming &&
    previous.clipCount === next.clipCount &&
    previous.onSelect === next.onSelect &&
    previous.onContextMenu === next.onContextMenu &&
    previous.onToggle === next.onToggle &&
    previous.onStartRename === next.onStartRename &&
    previous.onRenameCommit === next.onRenameCommit &&
    previous.onRenameCancel === next.onRenameCancel &&
    previous.onResizePointerDown === next.onResizePointerDown
  );
}
