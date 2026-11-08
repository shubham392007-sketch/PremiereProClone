import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, HardDrive, Info } from 'lucide-react';
import type { ColorSpace, FrameRate, PreviewQuality } from '@/types';
import {
  ASPECT_PRESETS,
  AUDIO_SAMPLE_RATES,
  COLOR_SPACES,
  FRAME_RATE_PRESETS,
  PREVIEW_QUALITIES,
  RESOLUTION_PRESETS,
  aspectRatioLabel,
} from '@/utils/presets';
import { mediaStorage } from '@/services/storage/media-storage';
import { useProjectStore } from '@/stores/project-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useWorkspaceStore, notify } from '@/stores/workspace-store';
import { Modal } from '@/components/common/Modal';
import { NumberField } from '@/components/common/NumberField';
import { SelectField } from '@/components/common/SelectField';

const RESOLUTION_LONG_SIDE: Record<string, number> = {
  '720p': 1280,
  '1080p': 1920,
  '1440p': 2560,
  '4k': 3840,
};

const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);

function dimensionsFor(resolutionId: string, aspectId: string): { width: number; height: number } {
  const long = RESOLUTION_LONG_SIDE[resolutionId] ?? 1920;
  switch (aspectId) {
    case '9:16':
      return { width: even((long * 9) / 16), height: even(long) };
    case '1:1': {
      const side = even((long * 9) / 16);
      return { width: side, height: side };
    }
    case '4:3': {
      const short = even((long * 9) / 16);
      return { width: even((short * 4) / 3), height: short };
    }
    case 'custom':
      return { width: even(long), height: even((long * 9) / 16) };
    case '16:9':
    default:
      return { width: even(long), height: even((long * 9) / 16) };
  }
}

export function NewProjectDialog() {
  const open = useWorkspaceStore((s) => s.dialogs['new-project']);
  const closeDialog = useWorkspaceStore((s) => s.closeDialog);
  const createNewProject = useProjectStore((s) => s.createNewProject);

  const [name, setName] = useState('Untitled Project');
  const [sequenceName, setSequenceName] = useState('Sequence 01');
  const [resolutionId, setResolutionId] = useState('1080p');
  const [aspectId, setAspectId] = useState('16:9');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [frameRateLabel, setFrameRateLabel] = useState('30');
  const [audioSampleRate, setAudioSampleRate] = useState('48000');
  const [colorSpace, setColorSpace] = useState<ColorSpace>('Rec.709');
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>('full');
  const [backend, setBackend] = useState<'opfs' | 'indexeddb' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    void mediaStorage.backend().then(setBackend);
  }, [open]);

  const frameRate: FrameRate = useMemo(
    () => FRAME_RATE_PRESETS.find((f) => f.label === frameRateLabel) ?? FRAME_RATE_PRESETS[4],
    [frameRateLabel],
  );

  const isCustom = resolutionId === 'custom' || aspectId === 'custom';

  const applyPreset = (nextResolution: string, nextAspect: string) => {
    setResolutionId(nextResolution);
    setAspectId(nextAspect);
    if (nextResolution === 'custom' || nextAspect === 'custom') return;
    const dims = dimensionsFor(nextResolution, nextAspect);
    setWidth(dims.width);
    setHeight(dims.height);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Project name is required.');
      return;
    }
    if (width < 16 || height < 16 || width > 7680 || height > 4320) {
      setError('Resolution must be between 16×16 and 7680×4320.');
      return;
    }
    if (width % 2 !== 0 || height % 2 !== 0) {
      setError('Video dimensions must be even numbers for H.264 export compatibility.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await createNewProject({
        name: trimmed,
        sequenceName: sequenceName.trim() || 'Sequence 01',
        width,
        height,
        frameRate,
        audioSampleRate: Number(audioSampleRate),
        colorSpace,
        previewQuality,
      });
      useTimelineStore.getState().initFromWorkspace(project.workspace);
      closeDialog('new-project');
      notify(
        'success',
        'Project created',
        `${project.name} · ${width}×${height} · ${frameRate.label} fps`,
        3500,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Project could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New Project"
      subtitle="Create a project and its first editing sequence"
      onClose={() => closeDialog('new-project')}
      busy={busy}
      width={640}
      footer={
        <>
          <button type="button" className="btn" onClick={() => closeDialog('new-project')} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary min-w-[132px]" onClick={() => void handleCreate()} disabled={busy}>
            {busy ? 'Creating…' : (
              <>
                <Clapperboard size={13} /> Create Project
              </>
            )}
          </button>
        </>
      }
    >
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label mb-1 block">Project Name</label>
            <input
              className="field"
              value={name}
              autoFocus
              placeholder="My Video Edit"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void handleCreate();
              }}
            />
          </div>
          <div>
            <label className="label mb-1 block">Sequence Name</label>
            <input
              className="field"
              value={sequenceName}
              placeholder="Sequence 01"
              onChange={(e) => setSequenceName(e.target.value)}
            />
          </div>
          <div>
            <label className="label mb-1 block">Location</label>
            <div className="flex h-7 items-center gap-1.5 border border-app-border bg-[#191919] px-2 text-2xs text-app-textDim">
              <HardDrive size={11} />
              Browser storage {backend ? `(${backend === 'opfs' ? 'OPFS' : 'IndexedDB'})` : ''}
            </div>
          </div>
        </div>

        <div className="border-t border-app-border pt-3">
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-app-textDim">Sequence settings</h3>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Resolution"
              value={isCustom && resolutionId !== 'custom' ? 'custom' : resolutionId}
              onValueChange={(value) => applyPreset(value, aspectId === 'custom' ? '16:9' : aspectId)}
              options={[
                ...RESOLUTION_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
                { value: 'custom', label: `Custom${isCustom ? ` — ${width} × ${height}` : ''}` },
              ]}
            />
            <SelectField
              label="Aspect Ratio"
              value={aspectId}
              onValueChange={(value) => applyPreset(resolutionId === 'custom' ? '1080p' : resolutionId, value)}
              options={ASPECT_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })).concat([
                { value: 'custom', label: 'Custom ratio' },
              ])}
            />
            {isCustom ? (
              <>
                <NumberField label="Width (px)" value={width} min={16} max={7680} step={2} onChange={(v) => setWidth(even(v))} />
                <NumberField label="Height (px)" value={height} min={16} max={4320} step={2} onChange={(v) => setHeight(even(v))} />
              </>
            ) : null}
            <SelectField
              label="Frame Rate"
              value={frameRateLabel}
              onValueChange={setFrameRateLabel}
              options={FRAME_RATE_PRESETS.map((f) => ({ value: f.label, label: `${f.label} fps` }))}
            />
            <SelectField
              label="Audio Sample Rate"
              value={audioSampleRate}
              onValueChange={setAudioSampleRate}
              options={AUDIO_SAMPLE_RATES.map((rate) => ({ value: String(rate), label: `${rate / 1000} kHz` }))}
            />
            <SelectField
              label="Color Space"
              value={colorSpace}
              onValueChange={(value) => setColorSpace(value as ColorSpace)}
              options={COLOR_SPACES.map((space) => ({ value: space, label: space }))}
            />
            <SelectField
              label="Preview Quality"
              value={previewQuality}
              onValueChange={(value) => setPreviewQuality(value as PreviewQuality)}
              options={PREVIEW_QUALITIES.map((quality) => ({ value: quality.id, label: quality.label }))}
              hint="Affects program monitor playback resolution"
            />
          </div>
        </div>

        <div className="flex items-center justify-between border border-app-border bg-[#1d1d1d] px-3 py-2">
          <div className="flex items-center gap-2 text-2xs text-app-textDim">
            <Info size={12} className="text-app-textFaint" />
            Sequence summary
          </div>
          <div className="text-2xs text-app-text">
            {width} × {height} · {aspectRatioLabel(width, height)} · {frameRate.label} fps · {Number(audioSampleRate) / 1000} kHz
          </div>
        </div>

        {error ? (
          <p className="border border-[#6b2b2b] bg-[#2a1c1c] px-3 py-2 text-2xs text-[#ffb3b3]">{error}</p>
        ) : null}
      </div>
    </Modal>
  );
}
