/**
 * Contextual Properties panel.
 *
 * Shows editable clip properties for the current timeline selection. Edits go
 * through `useTimelineStore.setClipProperties` (one undo entry per discrete
 * change) and, for slider drags, through `beginEdit()` / `liveEdit()` /
 * `endEdit()` so a whole drag collapses into a single undo entry. The Program
 * Monitor repaints automatically because it subscribes to the project store.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Film,
  Image as ImageIcon,
  Info,
  Layers,
  Lock,
  Music,
  SlidersHorizontal,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { NumberField } from '@/components/common/NumberField';
import { SelectField } from '@/components/common/SelectField';
import { EmptyState } from '@/components/common/EmptyState';
import { cn } from '@/utils/format';
import { findSequence } from '@/engine/timeline/factory';
import { setClipsEnabled } from '@/engine/timeline/operations';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useMediaStore } from '@/stores/media-store';
import { maxDurationFramesForAsset } from '@/utils/media-frames';
import { frameToTimecode, sequenceDurationFrames } from '@/utils/time';
import type { MediaAsset, Project, Sequence, TimelineClip } from '@/types';

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MAX_TIMELINE_FRAMES = 100000;

/* ------------------------------------------------------------------ */
/* small shared widgets                                                */
/* ------------------------------------------------------------------ */

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="border-b border-app-border px-2 py-2 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-3xs uppercase tracking-wide text-app-textFaint">{title}</h3>
        {action}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-2xs">
      <span className="shrink-0 text-app-textDim">{label}</span>
      <span className="min-w-0 truncate text-right text-app-text" title={value}>
        {value}
      </span>
    </div>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-1.5 text-2xs text-app-textDim',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

interface PropertySliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  commitLabel: string;
  disabled?: boolean;
  onLive: (value: number) => void;
  formatValue?: (value: number) => string;
}

/**
 * Slider that opens a live-edit transaction on pointer/focus and commits one
 * undo entry on release/blur.
 */
function PropertySlider({
  label,
  value,
  min,
  max,
  step = 1,
  commitLabel,
  disabled,
  onLive,
  formatValue,
}: PropertySliderProps) {
  const beforeRef = useRef<Project | null>(null);
  const startedRef = useRef(false);

  const begin = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    beforeRef.current = useTimelineStore.getState().beginEdit();
  };
  const end = () => {
    if (!startedRef.current) return;
    startedRef.current = false;
    const before = beforeRef.current;
    beforeRef.current = null;
    if (before) useTimelineStore.getState().endEdit(before, commitLabel);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <span className="text-2xs tabular-nums text-app-text">
          {formatValue ? formatValue(value) : String(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerCancel={end}
        onFocus={begin}
        onBlur={end}
        onChange={(event) => {
          begin();
          onLive(Number(event.target.value));
        }}
      />
    </div>
  );
}

function ClipNameField({ clip }: { clip: TimelineClip }) {
  const [text, setText] = useState(clip.name ?? '');
  useEffect(() => {
    setText(clip.name ?? '');
  }, [clip.id, clip.name]);

  return (
    <input
      className="field-sm font-medium"
      value={text}
      aria-label="Clip name"
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const trimmed = text.trim();
        if (trimmed === (clip.name ?? '')) return;
        useTimelineStore
          .getState()
          .setClipProperties(clip.id, { name: trimmed || undefined }, 'Rename clip');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          setText(clip.name ?? '');
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function OfflineNotice({ asset }: { asset: MediaAsset | undefined }) {
  return (
    <div className="flex items-start gap-1.5 rounded border border-[#7a3434] bg-[#2c1a1a] px-2 py-1.5 text-3xs leading-relaxed text-[#ffb0b0]">
      <WifiOff size={11} className="mt-0.5 shrink-0" />
      <span>
        {asset
          ? 'Media is offline — the source file could not be found. Re-import or relink it in the Project panel to restore preview and playback.'
          : 'The media for this clip no longer exists in the project. Undo the media removal or re-import the file.'}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* clip helpers                                                        */
/* ------------------------------------------------------------------ */

function clipKind(asset: MediaAsset | undefined): 'video' | 'audio' | 'image' {
  return asset?.kind ?? 'video';
}

function clipDisplayName(clip: TimelineClip, asset: MediaAsset | undefined): string {
  return clip.name?.trim() || asset?.name || 'Clip';
}

function sourceAvailableFrames(asset: MediaAsset | undefined, sequence: Sequence, clip: TimelineClip): number {
  const sourceMax = maxDurationFramesForAsset(asset, sequence);
  if (!Number.isFinite(sourceMax) || sourceMax >= MAX_TIMELINE_FRAMES) return MAX_TIMELINE_FRAMES;
  const speed = Math.max(0.01, clip.playbackRate || 1);
  return Math.max(1, Math.min(MAX_TIMELINE_FRAMES, Math.floor((sourceMax - clip.sourceInFrame) / speed)));
}

function applyClipPatch(clipId: string, patch: Partial<TimelineClip>, label: string) {
  useTimelineStore.getState().setClipProperties(clipId, patch, label);
}

/** Live-edit a single clip inside the active sequence (no history per call). */
function liveClip(clipId: string, mutator: (clip: TimelineClip) => void) {
  useTimelineStore.getState().liveEdit((draft) => {
    const target = draft.clips.find((clip) => clip.id === clipId);
    if (target) mutator(target);
  });
}

/* ------------------------------------------------------------------ */
/* audio section (shared by audio clips and video clips with audio)     */
/* ------------------------------------------------------------------ */

function AudioSection({
  clip,
  sequence,
  asset,
}: {
  clip: TimelineClip;
  sequence: Sequence;
  asset: MediaAsset | undefined;
}) {
  const fps = sequence.frameRate;
  const audio = clip.audio;
  const fadeMax = Math.max(0, clip.durationFrames);
  void asset;

  return (
    <Section title="Audio">
      <PropertySlider
        label="Volume"
        value={Math.round(audio.gain * 100)}
        min={0}
        max={200}
        step={1}
        commitLabel="Adjust volume"
        onLive={(value) =>
          liveClip(clip.id, (target) => {
            target.audio.gain = Math.min(2, Math.max(0, value / 100));
          })
        }
        formatValue={(value) => `${value}%`}
      />
      <CheckboxRow
        label="Mute clip audio"
        checked={audio.muted}
        onChange={(checked) => applyClipPatch(clip.id, { audio: { ...audio, muted: checked } }, 'Mute clip')}
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5">
          <NumberField
            label="Fade In"
            value={audio.fadeInFrames}
            min={0}
            max={fadeMax}
            precision={0}
            unit="fr"
            onChange={(value) =>
              applyClipPatch(
                clip.id,
                { audio: { ...audio, fadeInFrames: Math.min(fadeMax, Math.max(0, Math.round(value))) } },
                'Change fade in',
              )
            }
          />
          <span className="text-3xs text-app-textFaint">{frameToTimecode(audio.fadeInFrames, fps)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <NumberField
            label="Fade Out"
            value={audio.fadeOutFrames}
            min={0}
            max={fadeMax}
            precision={0}
            unit="fr"
            onChange={(value) =>
              applyClipPatch(
                clip.id,
                { audio: { ...audio, fadeOutFrames: Math.min(fadeMax, Math.max(0, Math.round(value))) } },
                'Change fade out',
              )
            }
          />
          <span className="text-3xs text-app-textFaint">{frameToTimecode(audio.fadeOutFrames, fps)}</span>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* single clip                                                         */
/* ------------------------------------------------------------------ */

function SingleClipProperties({
  clip,
  sequence,
  asset,
  offline,
}: {
  clip: TimelineClip;
  sequence: Sequence;
  asset: MediaAsset | undefined;
  offline: boolean;
}) {
  const kind = clipKind(asset);
  const hasPicture = kind !== 'audio';
  const transform = clip.transform;
  const fps = sequence.frameRate;
  const maxDuration = sourceAvailableFrames(asset, sequence, clip);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-app-border px-2 py-2">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-white',
            kind === 'audio' ? 'bg-[#2f6554]' : kind === 'image' ? 'bg-[#6b4b2c]' : 'bg-[#33587f]',
          )}
        >
          {kind === 'audio' ? (
            <Music size={13} />
          ) : kind === 'image' ? (
            <ImageIcon size={13} />
          ) : (
            <Film size={13} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <ClipNameField clip={clip} />
          <div className="mt-0.5 flex items-center gap-1 text-3xs text-app-textFaint">
            <span className="truncate">{asset?.name ?? 'Missing media'}</span>
            {offline ? (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-sm bg-[#3a1d1d] px-1 text-[#ffb0b0]">
                <AlertTriangle size={9} /> Offline
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <Section title="Clip">
        {offline ? <OfflineNotice asset={asset} /> : null}
        <InfoRow label="Media" value={asset?.name ?? 'Missing media'} />
        <InfoRow label="File" value={asset?.fileName ?? '—'} />
        <InfoRow
          label="Type"
          value={
            kind === 'image'
              ? 'Image'
              : kind === 'audio'
                ? 'Audio'
                : asset?.hasAudio
                  ? 'Video + audio'
                  : 'Video'
          }
        />
        {asset && asset.kind !== 'image' ? (
          <InfoRow
            label="Source in"
            value={`${clip.sourceInFrame} fr · ${frameToTimecode(clip.sourceInFrame, fps)}`}
          />
        ) : null}
        <InfoRow label="Enabled" value={clip.enabled ? 'Yes' : 'No (not rendered)'} />
        <CheckboxRow
          label="Clip enabled"
          checked={clip.enabled}
          onChange={(checked) => applyClipPatch(clip.id, { enabled: checked }, checked ? 'Enable clip' : 'Disable clip')}
        />
      </Section>

      <Section title="Timing">
        <div className="flex flex-col gap-0.5">
          <NumberField
            label="Duration"
            value={clip.durationFrames}
            min={1}
            max={maxDuration}
            precision={0}
            unit="fr"
            onChange={(value) =>
              applyClipPatch(
                clip.id,
                { durationFrames: Math.min(maxDuration, Math.max(1, Math.round(value))) },
                'Change clip duration',
              )
            }
          />
          <span className="text-3xs text-app-textFaint">
            {frameToTimecode(clip.durationFrames, fps)} · max {maxDuration} frames
            {asset?.kind === 'image' ? ' (stills can be any length)' : ' available from source'}
          </span>
        </div>
        <SelectField
          label="Speed"
          value={String(clip.playbackRate)}
          options={SPEED_OPTIONS.map((speed) => ({ value: String(speed), label: `${speed}×` }))}
          onValueChange={(value) =>
            applyClipPatch(clip.id, { playbackRate: Number(value) }, 'Change clip speed')
          }
          hint="Speed changes how fast source frames are consumed; duration stays fixed."
        />
        <div className="flex items-baseline justify-between gap-2 text-2xs">
          <span className="text-app-textDim">Timeline range</span>
          <span className="text-app-text">
            {clip.startFrame} – {clip.startFrame + clip.durationFrames} fr
          </span>
        </div>
      </Section>

      {hasPicture ? (
        <Section title="Transform">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Position X"
              value={transform.x}
              min={-100000}
              max={100000}
              precision={0}
              unit="px"
              onChange={(value) =>
                applyClipPatch(
                  clip.id,
                  { transform: { ...transform, x: Math.round(value) } },
                  'Move clip',
                )
              }
            />
            <NumberField
              label="Position Y"
              value={transform.y}
              min={-100000}
              max={100000}
              precision={0}
              unit="px"
              onChange={(value) =>
                applyClipPatch(
                  clip.id,
                  { transform: { ...transform, y: Math.round(value) } },
                  'Move clip',
                )
              }
            />
            <NumberField
              label="Scale"
              value={Math.round(transform.scale * 100)}
              min={1}
              max={1000}
              precision={0}
              unit="%"
              onChange={(value) =>
                applyClipPatch(
                  clip.id,
                  { transform: { ...transform, scale: Math.min(10, Math.max(0.01, value / 100)) } },
                  'Change scale',
                )
              }
            />
            <NumberField
              label="Rotation"
              value={transform.rotation}
              min={-360}
              max={360}
              precision={0}
              unit="°"
              onChange={(value) =>
                applyClipPatch(
                  clip.id,
                  { transform: { ...transform, rotation: Math.round(value) } },
                  'Rotate clip',
                )
              }
            />
          </div>
          <PropertySlider
            label="Opacity"
            value={Math.round(transform.opacity * 100)}
            min={0}
            max={100}
            step={1}
            commitLabel="Adjust opacity"
            onLive={(value) =>
              liveClip(clip.id, (target) => {
                target.transform.opacity = Math.min(1, Math.max(0, value / 100));
              })
            }
            formatValue={(value) => `${value}%`}
          />
          <button
            type="button"
            className="btn h-6 self-start px-2 text-2xs"
            onClick={() =>
              applyClipPatch(
                clip.id,
                { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } },
                'Reset transform',
              )
            }
          >
            Reset transform
          </button>
        </Section>
      ) : null}

      {asset?.kind === 'audio' || asset?.hasAudio ? (
        <AudioSection clip={clip} sequence={sequence} asset={asset} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* multi selection                                                     */
/* ------------------------------------------------------------------ */

function MultiClipProperties({
  clips,
  mediaById,
}: {
  clips: TimelineClip[];
  mediaById: Map<string, MediaAsset>;
}) {
  const ids = clips.map((clip) => clip.id);
  const counts = { video: 0, audio: 0, image: 0 };
  for (const clip of clips) counts[clipKind(mediaById.get(clip.mediaId))] += 1;

  const enableAll = () =>
    useTimelineStore.getState().edit('Enable clips', (draft) => setClipsEnabled(draft, ids, true));
  const disableAll = () =>
    useTimelineStore.getState().edit('Disable clips', (draft) => setClipsEnabled(draft, ids, false));
  const deleteAll = () => useTimelineStore.getState().deleteClipsByIds(ids, 'Delete clips');
  const clearSelection = () => useTimelineStore.getState().clearSelection();

  return (
    <div className="flex flex-col gap-2 px-2 py-2">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-[#2d2d2d] text-app-textDim">
          <Layers size={14} />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-app-text">{clips.length} clips selected</p>
          <p className="text-3xs text-app-textFaint">
            {counts.video} video · {counts.image} image · {counts.audio} audio
          </p>
        </div>
      </div>

      <p className="text-3xs leading-relaxed text-app-textFaint">
        Multiple clips are selected. Shared actions are available; select one clip to edit its transform,
        audio or timing.
      </p>

      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn h-6 px-2 text-2xs" onClick={enableAll}>
          Enable all
        </button>
        <button type="button" className="btn h-6 px-2 text-2xs" onClick={disableAll}>
          Disable all
        </button>
        <button type="button" className="btn h-6 px-2 text-2xs" onClick={clearSelection}>
          Clear selection
        </button>
        <button type="button" className="btn-danger h-6 px-2 text-2xs" onClick={deleteAll}>
          <Trash2 size={11} /> Delete
        </button>
      </div>

      <ul className="max-h-40 divide-y divide-app-border overflow-y-auto rounded border border-app-border bg-[#1b1b1b]">
        {clips.slice(0, 10).map((clip) => {
          const asset = mediaById.get(clip.mediaId);
          return (
            <li key={clip.id} className="flex items-center justify-between gap-2 px-2 py-1 text-2xs">
              <span className="min-w-0 truncate text-app-textDim">{clipDisplayName(clip, asset)}</span>
              <span className="shrink-0 text-3xs uppercase text-app-textFaint">
                {clipKind(asset)}
              </span>
            </li>
          );
        })}
        {clips.length > 10 ? (
          <li className="px-2 py-1 text-3xs text-app-textFaint">+{clips.length - 10} more clips…</li>
        ) : null}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* no selection                                                        */
/* ------------------------------------------------------------------ */

function SequenceProperties({ sequence }: { sequence: Sequence }) {
  const fps = sequence.frameRate;
  const duration = sequenceDurationFrames(sequence);
  const videoTracks = sequence.tracks.filter((track) => track.kind === 'video').length;
  const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio').length;

  return (
    <div className="flex flex-col">
      <div className="border-b border-app-border px-2 py-2">
        <div className="flex items-start gap-1.5 rounded border border-app-border bg-[#1b1b1b] px-2 py-1.5">
          <Info size={12} className="mt-0.5 shrink-0 text-app-textFaint" />
          <div>
            <p className="text-2xs text-app-textDim">Select a clip to edit properties</p>
            <p className="mt-0.5 text-3xs leading-relaxed text-app-textFaint">
              Click a clip in the Timeline. Transform, opacity, audio and timing controls appear here.
            </p>
          </div>
        </div>
      </div>
      <Section title="Sequence">
        <InfoRow label="Name" value={sequence.name} />
        <InfoRow label="Resolution" value={`${sequence.width} × ${sequence.height}`} />
        <InfoRow label="Frame rate" value={`${fps.label} fps`} />
        <InfoRow label="Duration" value={`${frameToTimecode(duration, fps)} · ${duration} frames`} />
        <InfoRow label="Video tracks" value={String(videoTracks)} />
        <InfoRow label="Audio tracks" value={String(audioTracks)} />
        <InfoRow label="Clips" value={String(sequence.clips.length)} />
        <InfoRow label="Markers" value={String(sequence.markers.length)} />
        <InfoRow label="Audio rate" value={`${sequence.audioSampleRate} Hz`} />
        <InfoRow label="Color space" value={sequence.colorSpace} />
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* phase 2 placeholders                                                */
/* ------------------------------------------------------------------ */

function Phase2Sections() {
  const sections = ['Color correction', 'Video effects', 'Keyframes & animation'];
  return (
    <div className="border-t border-app-border px-2 py-2">
      <p className="mb-1.5 text-3xs uppercase tracking-wide text-app-textFaint">Advanced</p>
      <div className="flex flex-col gap-1">
        {sections.map((section) => (
          <div
            key={section}
            className="flex items-center justify-between gap-2 rounded border border-dashed border-app-border bg-[#1c1c1c] px-2 py-1 text-2xs"
            title={`${section} is not available in Phase 1`}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-app-textDim">
              <Lock size={10} className="shrink-0 text-app-textFaint" />
              <span className="truncate">{section}</span>
            </span>
            <span className="shrink-0 text-3xs text-app-textFaint">Phase 2 — unavailable</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* panel                                                               */
/* ------------------------------------------------------------------ */

export function PropertiesPanel() {
  const project = useProjectStore((state) => state.project);
  const selectedIds = useTimelineStore((state) => state.selectedClipIds);
  const urls = useMediaStore((state) => state.urls);

  const sequence = useMemo(
    () => (project ? findSequence(project) ?? project.sequences[0] ?? null : null),
    [project],
  );
  const mediaById = useMemo(
    () => new Map<string, MediaAsset>((project?.media ?? []).map((asset) => [asset.id, asset])),
    [project],
  );
  const selectedClips = useMemo(() => {
    if (!sequence) return [];
    const wanted = new Set(selectedIds);
    return sequence.clips.filter((clip) => wanted.has(clip.id));
  }, [sequence, selectedIds]);

  return (
    <div data-testid="properties-panel" className="panel h-full min-h-0 bg-app-panel">
      <div className="panel-header shrink-0 justify-between">
        <span className="flex items-center gap-1.5">
          <SlidersHorizontal size={12} className="text-app-textFaint" />
          Properties
        </span>
        {sequence ? (
          <span className="truncate text-3xs text-app-textFaint" title={sequence.name}>
            {sequence.name}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!project || !sequence ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="No project open"
            description="Open or create a project to edit clip properties."
          />
        ) : selectedClips.length === 0 ? (
          <SequenceProperties sequence={sequence} />
        ) : selectedClips.length === 1 ? (
          (() => {
            const clip = selectedClips[0];
            const asset = mediaById.get(clip.mediaId);
            const offline = !asset || Boolean(asset.missing) || !urls[clip.mediaId];
            return (
              <SingleClipProperties
                key={clip.id}
                clip={clip}
                sequence={sequence}
                asset={asset}
                offline={offline}
              />
            );
          })()
        ) : (
          <MultiClipProperties clips={selectedClips} mediaById={mediaById} />
        )}

        <Phase2Sections />
      </div>
    </div>
  );
}

export default PropertiesPanel;
