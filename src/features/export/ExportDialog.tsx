/**
 * Export dialog for the active sequence.
 *
 * Rendered unconditionally by the workspace (no props) and controlled through
 * the workspace store: visible when `dialogs.export` is true, closes through
 * `closeDialog('export')`. Everything shown here is real: the progress bar is
 * driven by processed frame counts, and the Download button points at the
 * actual encoded Blob produced by the export engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Film,
  HardDrive,
  Info,
  RefreshCw,
  Volume2,
  XCircle,
} from 'lucide-react';
import type { ExportProgress, ExportSettings, FrameRate, Sequence } from '@/types';
import { Modal } from '@/components/common/Modal';
import { NumberField } from '@/components/common/NumberField';
import { SelectField } from '@/components/common/SelectField';
import { Spinner } from '@/components/common/EmptyState';
import { useProjectStore } from '@/stores/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { cn, formatBytes } from '@/utils/format';
import {
  AUDIO_SAMPLE_RATES,
  FRAME_RATE_PRESETS,
  RESOLUTION_PRESETS,
  aspectRatioLabel,
  formatDuration,
} from '@/utils/presets';
import {
  buildExportFileName,
  cancelExport,
  createDefaultExportSettings,
  exportActiveSequence,
  getExportCapabilities,
  getExportEstimate,
  getSequenceDurationSeconds,
  isExportCancelledError,
  suggestedVideoBitrate,
} from '@/services/export-service';
import type { ExportCapabilities, ExportResult } from '@/engine/exporter/types';

type ExportFormat = 'mp4-h264' | 'mp4-vp9' | 'webm-fallback';
type ExportStatus = 'idle' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';
type QualityPreset = 'low' | 'medium' | 'high' | 'max' | 'custom';

interface ProgramMarks {
  inFrame: number | null;
  outFrame: number | null;
}

const QUALITY_FACTORS: Record<Exclude<QualityPreset, 'custom'>, number> = {
  low: 0.09,
  medium: 0.15,
  high: 0.24,
  max: 0.36,
};

const QUALITY_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium (recommended)' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Maximum' },
  { value: 'custom', label: 'Custom bitrate' },
];

const PHASE_LABELS: Record<ExportProgress['phase'], string> = {
  preparing: 'Preparing',
  rendering: 'Rendering frames',
  encoding: 'Encoding',
  muxing: 'Writing file',
  done: 'Complete',
  error: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Program In/Out marks are optional store fields (the program monitor may add
 * them later); read them defensively rather than importing a store shape that
 * does not exist yet.
 */
function readProgramMarks(): ProgramMarks {
  try {
    const state = usePlaybackStore.getState() as unknown as Record<string, unknown>;
    const readNumber = (keys: string[]): number | null => {
      for (const key of keys) {
        const value = state[key];
        if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
      }
      return null;
    };
    return {
      inFrame: readNumber(['programInFrame', 'programInPointFrame', 'programIn', 'inFrame']),
      outFrame: readNumber(['programOutFrame', 'programOutPointFrame', 'programOut', 'outFrame']),
    };
  } catch {
    return { inFrame: null, outFrame: null };
  }
}

function findResolutionPresetId(width: number, height: number): string {
  return RESOLUTION_PRESETS.find((preset) => preset.width === width && preset.height === height)?.id ?? 'custom';
}

function frameRateValue(frameRate: FrameRate): string {
  return `${frameRate.num}/${frameRate.den}`;
}

function parseFrameRate(value: string): FrameRate | null {
  const [numText, denText] = value.split('/');
  const num = Number(numText);
  const den = Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  const preset = FRAME_RATE_PRESETS.find((candidate) => candidate.num === num && candidate.den === den);
  return { num, den, label: preset?.label ?? String(Math.round((num / den) * 1000) / 1000) };
}

function buildEffectiveSettings(
  settings: ExportSettings,
  format: ExportFormat,
  rangeMode: 'entire' | 'in-out',
  marks: ProgramMarks,
): ExportSettings {
  const useInOut =
    rangeMode === 'in-out' &&
    marks.inFrame !== null &&
    marks.outFrame !== null &&
    marks.outFrame > marks.inFrame;
  return {
    ...settings,
    videoCodec: format === 'mp4-vp9' ? 'vp9' : 'h264',
    range: useInOut ? 'in-out' : 'entire',
    rangeInFrame: useInOut ? (marks.inFrame ?? undefined) : undefined,
    rangeOutFrame: useInOut ? (marks.outFrame ?? undefined) : undefined,
  };
}

export function ExportDialog() {
  const open = useWorkspaceStore((state) => state.dialogs.export);
  const closeDialog = useWorkspaceStore((state) => state.closeDialog);
  const notify = useWorkspaceStore((state) => state.notify);
  const project = useProjectStore((state) => state.project);

  const sequence = useMemo<Sequence | null>(() => {
    if (!project) return null;
    return project.sequences.find((candidate) => candidate.id === project.activeSequenceId) ?? project.sequences[0] ?? null;
  }, [project]);
  const sequenceId = sequence?.id ?? null;

  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [format, setFormat] = useState<ExportFormat>('mp4-h264');
  const [quality, setQuality] = useState<QualityPreset>('medium');
  const [resolutionChoice, setResolutionChoice] = useState('custom');
  const [rangeMode, setRangeMode] = useState<'entire' | 'in-out'>('entire');
  const [rangeMarks, setRangeMarks] = useState<ProgramMarks>({ inFrame: null, outFrame: null });
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const downloadUrlRef = useRef<string | null>(null);

  const isRunning = status === 'running' || status === 'cancelling';

  const revokeDownloadUrl = useCallback(() => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setDownloadUrl(null);
  }, []);

  // Track mount state for async export completion.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (runningRef.current) cancelExport();
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = null;
      }
    };
  }, []);

  // Initialize settings when the dialog opens (or the active sequence changes).
  useEffect(() => {
    if (!open || !sequence) return;
    if (runningRef.current) return;
    const defaults = createDefaultExportSettings(sequence);
    setSettings(defaults);
    setQuality('medium');
    setResolutionChoice(findResolutionPresetId(defaults.width, defaults.height));
    setRangeMode('entire');
    setRangeMarks(readProgramMarks());
    setStatus('idle');
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setWarnings([]);
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setDownloadUrl(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sequenceId]);

  // Probe encoder capabilities once per open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCapsLoading(true);
    getExportCapabilities()
      .then((capabilities) => {
        if (cancelled) return;
        setCaps(capabilities);
        const preferred: ExportFormat = capabilities.h264
          ? 'mp4-h264'
          : capabilities.vp9
            ? 'mp4-vp9'
            : capabilities.mediaRecorder
              ? 'webm-fallback'
              : 'mp4-h264';
        setFormat(preferred);
        setSettings((previous) =>
          previous ? { ...previous, videoCodec: preferred === 'mp4-vp9' ? 'vp9' : 'h264' } : previous,
        );
      })
      .catch(() => {
        if (!cancelled) setCaps(null);
      })
      .finally(() => {
        if (!cancelled) setCapsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // When the dialog closes: cancel any run and release the blob URL.
  useEffect(() => {
    if (open) return;
    if (runningRef.current) cancelExport();
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setDownloadUrl(null);
    setResult(null);
    setStatus('idle');
    setProgress(null);
    setErrorMessage(null);
    setWarnings([]);
  }, [open]);

  const patchSettings = useCallback((patch: Partial<ExportSettings>) => {
    setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
  }, []);

  const updateVideoFormat = useCallback(
    (patch: Partial<Pick<ExportSettings, 'width' | 'height' | 'frameRate'>>) => {
      setSettings((previous) => {
        if (!previous) return previous;
        const merged = { ...previous, ...patch };
        const nextBitrate =
          quality === 'custom'
            ? merged.videoBitrate
            : suggestedVideoBitrate(merged.width, merged.height, merged.frameRate, QUALITY_FACTORS[quality]);
        return { ...merged, videoBitrate: nextBitrate };
      });
    },
    [quality],
  );

  const effectiveSettings = useMemo(
    () => (settings ? buildEffectiveSettings(settings, format, rangeMode, rangeMarks) : null),
    [settings, format, rangeMode, rangeMarks],
  );

  const estimate = useMemo(
    () => (sequence && effectiveSettings ? getExportEstimate(sequence, effectiveSettings) : null),
    [sequence, effectiveSettings],
  );

  const sequenceDurationSeconds = useMemo(
    () => (sequence ? getSequenceDurationSeconds(sequence) : 0),
    [sequence],
  );

  const hasInOutMarks =
    rangeMarks.inFrame !== null && rangeMarks.outFrame !== null && rangeMarks.outFrame > rangeMarks.inFrame;
  const inOutSeconds = hasInOutMarks && sequence
    ? ((rangeMarks.outFrame! - rangeMarks.inFrame!) * sequence.frameRate.den) / sequence.frameRate.num
    : 0;

  const formatOptions = useMemo(() => {
    const options: { value: ExportFormat; label: string }[] = [];
    if (!caps) return [{ value: 'mp4-h264' as ExportFormat, label: 'MP4 · H.264 (AVC)' }];
    if (caps.webCodecs && caps.h264) options.push({ value: 'mp4-h264', label: 'MP4 · H.264 (AVC)' });
    if (caps.webCodecs && caps.vp9) options.push({ value: 'mp4-vp9', label: 'MP4 · VP9' });
    if (!options.length && caps.mediaRecorder) {
      options.push({ value: 'webm-fallback', label: 'WebM · MediaRecorder (realtime fallback)' });
    }
    if (!options.length) options.push({ value: 'mp4-h264', label: 'MP4 · H.264 (unavailable)' });
    return options;
  }, [caps]);

  const frameRateOptions = useMemo(() => {
    const options = FRAME_RATE_PRESETS.map((preset) => ({
      value: frameRateValue(preset),
      label: `${preset.label} fps`,
    }));
    if (
      settings &&
      !FRAME_RATE_PRESETS.some(
        (preset) => preset.num === settings.frameRate.num && preset.den === settings.frameRate.den,
      )
    ) {
      options.unshift({
        value: frameRateValue(settings.frameRate),
        label: `${settings.frameRate.label} fps (sequence)`,
      });
    }
    return options;
  }, [settings]);

  const audioCodecLabel = caps?.aac ? 'AAC (mp4a.40.2)' : caps?.opus ? 'Opus (fallback, 48 kHz)' : 'Unavailable';
  const audioExtras = Boolean(caps && !caps.aac && caps.opus);
  const outputContainer = format === 'webm-fallback' ? 'webm' : 'mp4';
  const outputFileName = settings ? buildExportFileName(settings.fileName, outputContainer) : '';
  const aspectRatio = settings ? aspectRatioLabel(settings.width, settings.height) : '—';

  const canStart =
    Boolean(effectiveSettings) &&
    Boolean(estimate) &&
    Boolean(estimate && estimate.totalFrames > 0) &&
    Boolean(caps?.canExport) &&
    !capsLoading &&
    !isRunning;

  const handleRequestClose = useCallback(() => {
    if (runningRef.current) return;
    closeDialog('export');
  }, [closeDialog]);

  const handleStart = useCallback(async () => {
    if (!settings || !sequence || runningRef.current) return;
    const activeSettings = buildEffectiveSettings(settings, format, rangeMode, rangeMarks);
    const preflight = getExportEstimate(sequence, activeSettings);
    if (preflight.error) {
      setStatus('error');
      setErrorMessage(preflight.error);
      return;
    }
    setErrorMessage(null);
    setWarnings([]);
    setResult(null);
    revokeDownloadUrl();
    setProgress({
      phase: 'preparing',
      framesDone: 0,
      totalFrames: preflight.totalFrames,
      message: 'Preparing export…',
    });
    setStatus('running');
    runningRef.current = true;
    try {
      const outcome = await exportActiveSequence(activeSettings, {
        onProgress: (next) => {
          if (mountedRef.current) setProgress(next);
        },
        onWarning: (warning) => {
          if (!mountedRef.current) return;
          setWarnings((previous) => (previous.includes(warning) ? previous : [...previous, warning]));
        },
      });
      if (!mountedRef.current) return;
      const url = URL.createObjectURL(outcome.blob);
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = url;
      setDownloadUrl(url);
      setResult(outcome);
      setStatus('done');
      setProgress({
        phase: 'done',
        framesDone: outcome.totalFrames,
        totalFrames: outcome.totalFrames,
        message: 'Export complete.',
      });
      setWarnings((previous) => {
        const merged = [...previous];
        for (const warning of outcome.warnings) {
          if (!merged.includes(warning)) merged.push(warning);
        }
        return merged;
      });
      notify('success', 'Export complete', `${outcome.fileName} · ${formatBytes(outcome.sizeBytes)}`);
    } catch (error) {
      if (!mountedRef.current) return;
      if (isExportCancelledError(error)) {
        setStatus('cancelled');
        setProgress((previous) => ({
          phase: 'cancelled',
          framesDone: previous?.framesDone ?? 0,
          totalFrames: previous?.totalFrames ?? preflight.totalFrames,
          message: 'Export cancelled.',
        }));
        notify('info', 'Export cancelled', undefined, 2500);
      } else {
        const message = error instanceof Error ? error.message : 'The export failed.';
        setStatus('error');
        setErrorMessage(message);
        setProgress((previous) => ({
          phase: 'error',
          framesDone: previous?.framesDone ?? 0,
          totalFrames: previous?.totalFrames ?? preflight.totalFrames,
          message,
        }));
        notify('error', 'Export failed', message);
      }
    } finally {
      runningRef.current = false;
    }
  }, [settings, sequence, format, rangeMode, rangeMarks, revokeDownloadUrl, notify]);

  const handleCancel = useCallback(() => {
    if (!runningRef.current) return;
    cancelExport();
    setStatus('cancelling');
  }, []);

  const handleRetry = useCallback(() => {
    setStatus('idle');
    setProgress(null);
    setResult(null);
    setErrorMessage(null);
    setWarnings([]);
    revokeDownloadUrl();
  }, [revokeDownloadUrl]);

  const handleDownload = useCallback(() => {
    if (!downloadUrl || !result) return;
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = result.fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    notify('success', 'Download started', result.fileName, 2000);
  }, [downloadUrl, result, notify]);

  const handleFormatChange = (value: string) => {
    const nextFormat = value as ExportFormat;
    setFormat(nextFormat);
    if (nextFormat === 'webm-fallback') return;
    setSettings((previous) =>
      previous ? { ...previous, videoCodec: nextFormat === 'mp4-vp9' ? 'vp9' : 'h264' } : previous,
    );
  };

  const handleResolutionChange = (value: string) => {
    setResolutionChoice(value);
    if (value === 'custom') return;
    const preset = RESOLUTION_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateVideoFormat({ width: preset.width, height: preset.height });
  };

  const handleWidthChange = (width: number) => {
    setResolutionChoice('custom');
    updateVideoFormat({ width: Math.round(width) });
  };

  const handleHeightChange = (height: number) => {
    setResolutionChoice('custom');
    updateVideoFormat({ height: Math.round(height) });
  };

  const handleFrameRateChange = (value: string) => {
    const frameRate = parseFrameRate(value);
    if (!frameRate) return;
    updateVideoFormat({ frameRate });
  };

  const handleQualityChange = (value: string) => {
    const preset = value as QualityPreset;
    setQuality(preset);
    if (preset === 'custom' || !settings) return;
    patchSettings({
      videoBitrate: suggestedVideoBitrate(settings.width, settings.height, settings.frameRate, QUALITY_FACTORS[preset]),
    });
  };

  const phaseLabel = progress ? PHASE_LABELS[progress.phase] : 'Ready';
  const percent =
    progress && progress.totalFrames > 0
      ? Math.max(0, Math.min(100, Math.round((progress.framesDone / progress.totalFrames) * 100)))
      : 0;

  const renderCapabilityRow = (label: string, available: boolean | null): JSX.Element => (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-2xs text-app-textDim">{label}</span>
      {available === null ? (
        <span className="text-2xs text-app-textFaint">checking…</span>
      ) : available ? (
        <span className="flex items-center gap-1 text-2xs text-app-success">
          <CheckCircle2 size={11} /> Available
        </span>
      ) : (
        <span className="flex items-center gap-1 text-2xs text-app-warning">
          <XCircle size={11} /> Unavailable
        </span>
      )}
    </div>
  );

  const footer = (() => {
    if (status === 'running' || status === 'cancelling') {
      return (
        <button
          type="button"
          data-testid="export-cancel"
          className="btn-danger"
          onClick={handleCancel}
          disabled={status === 'cancelling'}
        >
          {status === 'cancelling' ? 'Cancelling…' : 'Cancel export'}
        </button>
      );
    }
    if (status === 'done' && downloadUrl) {
      return (
        <>
          <button type="button" data-testid="export-cancel" className="btn" onClick={handleRequestClose}>
            Close
          </button>
          <button type="button" data-testid="export-download" className="btn-primary" onClick={handleDownload}>
            <Download size={14} />
            Download{result ? ` · ${formatBytes(result.sizeBytes)}` : ''}
          </button>
        </>
      );
    }
    if (status === 'error' || status === 'cancelled') {
      return (
        <>
          <button type="button" data-testid="export-cancel" className="btn" onClick={handleRequestClose}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={handleRetry}>
            <RefreshCw size={14} />
            Back to settings
          </button>
        </>
      );
    }
    return (
      <>
        <button type="button" data-testid="export-cancel" className="btn" onClick={handleRequestClose} disabled={isRunning}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="export-start"
          className="btn-primary"
          onClick={() => {
            void handleStart();
          }}
          disabled={!canStart}
          title={!caps?.canExport ? 'This browser cannot export video' : undefined}
        >
          {capsLoading ? <Spinner size={12} /> : <Film size={14} />}
          Start Export
        </button>
      </>
    );
  })();

  return (
    <Modal
      open={open}
      title="Export Sequence"
      subtitle={sequence ? `${sequence.name} · ${aspectRatio} · ${sequence.frameRate.label} fps` : 'No sequence selected'}
      onClose={handleRequestClose}
      busy={isRunning}
      width={760}
      footer={footer}
    >
      <div data-testid="export-dialog" className="flex flex-col gap-3 p-3">
        {!project || !sequence || !settings ? (
          <div className="flex items-center gap-2 rounded border border-app-border bg-[#202020] p-4 text-xs text-app-textDim">
            <Info size={15} />
            Open a project with an active sequence before exporting.
          </div>
        ) : (
          <>
            {/* header summary */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-app-border bg-[#202020] px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs text-app-text">
                <Film size={13} className="text-app-accent" />
                <span className="font-medium">{sequence.name}</span>
              </div>
              <div className="flex items-center gap-1.5 text-2xs text-app-textDim">
                <Clock size={12} />
                {sequenceDurationSeconds > 0 ? formatDuration(sequenceDurationSeconds) : 'Empty sequence'}
              </div>
              <div className="flex items-center gap-1.5 text-2xs text-app-textDim">
                <HardDrive size={12} />
                {settings.width} × {settings.height} · {aspectRatio}
              </div>
            </div>

            <div
              className={cn(
                'grid grid-cols-1 gap-3 sm:grid-cols-2',
                isRunning && 'pointer-events-none opacity-60',
              )}
              aria-busy={isRunning}
            >
              {/* output / video */}
              <section className="flex flex-col gap-2 rounded border border-app-border bg-[#202020] p-3">
                <header className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-app-textDim">
                  <Film size={12} /> Output · Video
                </header>

                <div className="flex flex-col gap-1">
                  <label className="label" htmlFor="export-file-name">
                    File name
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      id="export-file-name"
                      className="field"
                      value={settings.fileName}
                      disabled={isRunning}
                      onChange={(event) => patchSettings({ fileName: event.target.value })}
                      spellCheck={false}
                    />
                    <span className="shrink-0 rounded border border-app-border bg-[#191919] px-1.5 py-[3px] text-2xs text-app-textDim">
                      .{outputContainer}
                    </span>
                  </div>
                  <span className="truncate text-3xs text-app-textFaint" title={outputFileName}>
                    Output: {outputFileName}
                  </span>
                </div>

                <SelectField
                  label="Format"
                  value={format}
                  onValueChange={handleFormatChange}
                  options={formatOptions}
                  disabled={isRunning}
                />

                <div className="grid grid-cols-2 gap-2">
                  <SelectField
                    label="Resolution"
                    value={resolutionChoice}
                    onValueChange={handleResolutionChange}
                    options={[
                      ...RESOLUTION_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
                      { value: 'custom', label: 'Custom…' },
                    ]}
                    disabled={isRunning}
                  />
                  <div className="grid grid-cols-2 gap-1">
                    <NumberField
                      label="Width"
                      value={settings.width}
                      min={32}
                      max={7680}
                      step={2}
                      unit="px"
                      disabled={isRunning}
                      onChange={handleWidthChange}
                    />
                    <NumberField
                      label="Height"
                      value={settings.height}
                      min={32}
                      max={4320}
                      step={2}
                      unit="px"
                      disabled={isRunning}
                      onChange={handleHeightChange}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <SelectField
                    label="Frame rate"
                    value={frameRateValue(settings.frameRate)}
                    onValueChange={handleFrameRateChange}
                    options={frameRateOptions}
                    disabled={isRunning}
                  />
                  <SelectField
                    label="Quality"
                    value={quality}
                    onValueChange={handleQualityChange}
                    options={QUALITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    disabled={isRunning}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="Video bitrate"
                    value={settings.videoBitrate / 1_000_000}
                    min={0.2}
                    max={120}
                    step={0.5}
                    precision={1}
                    unit="Mbps"
                    disabled={isRunning}
                    onChange={(value) => {
                      setQuality('custom');
                      patchSettings({ videoBitrate: Math.round(value * 1_000_000) });
                    }}
                  />
                  <div className="flex flex-col gap-0.5">
                    <span className="label">Estimated size</span>
                    <span className="flex h-6 items-center text-2xs text-app-textDim">
                      ~{formatBytes(estimate?.estimatedBytes ?? 0)}
                      <span className="ml-1 text-app-textFaint">(bitrate × duration)</span>
                    </span>
                  </div>
                </div>
              </section>

              {/* audio / range */}
              <section className="flex flex-col gap-2 rounded border border-app-border bg-[#202020] p-3">
                <header className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-app-textDim">
                  <Volume2 size={12} /> Audio
                </header>

                <label className="flex items-center gap-2 text-xs text-app-text">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={settings.audioEnabled}
                    disabled={isRunning}
                    onChange={(event) => patchSettings({ audioEnabled: event.target.checked })}
                  />
                  Include mixed timeline audio
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="label">Codec</span>
                    <span className="flex h-6 items-center text-2xs text-app-textDim">{audioCodecLabel}</span>
                  </div>
                  <NumberField
                    label="Audio bitrate"
                    value={settings.audioBitrate / 1000}
                    min={32}
                    max={512}
                    step={16}
                    unit="kbps"
                    disabled={isRunning || !settings.audioEnabled}
                    onChange={(value) => patchSettings({ audioBitrate: Math.round(value * 1000) })}
                  />
                </div>

                <SelectField
                  label="Sample rate"
                  value={String(settings.audioSampleRate)}
                  onValueChange={(value) => patchSettings({ audioSampleRate: Number(value) })}
                  options={AUDIO_SAMPLE_RATES.map((rate) => ({ value: String(rate), label: `${rate / 1000} kHz` }))}
                  disabled={isRunning || !settings.audioEnabled || audioExtras}
                  hint={audioExtras ? 'Opus fallback always encodes at 48 kHz.' : undefined}
                />

                {settings.audioEnabled && caps && !caps.aac && !caps.opus ? (
                  <p className="flex items-start gap-1.5 text-3xs leading-relaxed text-app-warning">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    No audio encoder is available; the export will be video-only.
                  </p>
                ) : null}

                <div className="separator-h" />

                <header className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-app-textDim">
                  <Clock size={12} /> Range
                </header>
                <label className="flex items-start gap-2 text-xs text-app-text">
                  <input
                    type="radio"
                    name="export-range"
                    className="mt-0.5"
                    checked={rangeMode === 'entire'}
                    disabled={isRunning}
                    onChange={() => setRangeMode('entire')}
                  />
                  <span>
                    Entire sequence
                    <span className="ml-1 text-2xs text-app-textFaint">
                      ({formatDuration(sequenceDurationSeconds)})
                    </span>
                  </span>
                </label>
                <label
                  className={cn(
                    'flex items-start gap-2 text-xs',
                    hasInOutMarks ? 'text-app-text' : 'text-app-textFaint',
                  )}
                >
                  <input
                    type="radio"
                    name="export-range"
                    className="mt-0.5"
                    checked={rangeMode === 'in-out'}
                    disabled={isRunning || !hasInOutMarks}
                    onChange={() => setRangeMode('in-out')}
                  />
                  <span>
                    In–Out range
                    <span className="ml-1 text-2xs text-app-textFaint">
                      {hasInOutMarks ? `(${formatDuration(inOutSeconds)})` : '— set In/Out marks in the Program Monitor'}
                    </span>
                  </span>
                </label>
                {estimate?.error ? (
                  <p className="flex items-start gap-1.5 text-3xs leading-relaxed text-app-warning">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    {estimate.error}
                  </p>
                ) : null}
              </section>
            </div>

            {/* capabilities */}
            <section className="flex flex-col gap-1.5 rounded border border-app-border bg-[#202020] p-3">
              <header className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-app-textDim">
                <Info size={12} /> Browser capabilities
                {capsLoading ? <Spinner size={10} className="ml-1" /> : null}
              </header>
              <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
                {renderCapabilityRow('WebCodecs', capsLoading ? null : Boolean(caps?.webCodecs))}
                {renderCapabilityRow('H.264 encoder', capsLoading ? null : Boolean(caps?.h264))}
                {renderCapabilityRow('VP9 encoder', capsLoading ? null : Boolean(caps?.vp9))}
                {renderCapabilityRow('AAC encoder', capsLoading ? null : Boolean(caps?.aac))}
                {renderCapabilityRow('Opus encoder', capsLoading ? null : Boolean(caps?.opus))}
                {renderCapabilityRow('MediaRecorder', capsLoading ? null : Boolean(caps?.mediaRecorder))}
              </div>
              {caps?.h264Codec || caps?.vp9Codec ? (
                <p className="text-3xs text-app-textFaint">
                  Codecs: {[caps?.h264Codec, caps?.vp9Codec].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              {caps && caps.warnings.length ? (
                <ul className="flex flex-col gap-1">
                  {caps.warnings.map((warning) => (
                    <li key={warning} className="flex items-start gap-1.5 text-3xs leading-relaxed text-app-warning">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                      {warning}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            {/* progress / result */}
            {progress ? (
              <section className="flex flex-col gap-1.5 rounded border border-app-border bg-[#202020] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xs font-semibold uppercase tracking-wide text-app-textDim">
                    {phaseLabel}
                  </span>
                  <span className="font-mono text-2xs tabular-nums text-app-textDim">
                    {progress.framesDone} / {progress.totalFrames} frames · {percent}%
                  </span>
                </div>
                <div
                  data-testid="export-progress"
                  role="progressbar"
                  aria-label="Export progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="h-2 w-full overflow-hidden rounded border border-app-border bg-[#141414]"
                >
                  <div
                    className={cn(
                      'h-full transition-[width] duration-150',
                      status === 'error' ? 'bg-app-danger' : status === 'cancelled' ? 'bg-app-warning' : 'bg-app-accent',
                    )}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <p data-testid="export-status" className="text-2xs text-app-textDim">
                  {progress.message}
                </p>

                {status === 'done' && result ? (
                  <div className="mt-1 flex items-start gap-2 rounded border border-[#2f5f49] bg-[#1d2b24] p-2">
                    <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-app-success" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-app-text">{result.fileName}</p>
                      <p className="text-2xs text-app-textDim">
                        {formatBytes(result.sizeBytes)} · {result.width}×{result.height} ·{' '}
                        {result.frameRate.label} fps · {result.durationSeconds.toFixed(2)}s ·{' '}
                        {result.videoCodec.toUpperCase()}
                        {result.audioCodec ? ` + ${result.audioCodec.toUpperCase()}` : ' · no audio'}
                      </p>
                      {result.fallback !== 'none' ? (
                        <p className="mt-1 flex items-start gap-1 text-2xs text-app-warning">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                          Fallback used: real-time WebM capture (WebCodecs unavailable).
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {status === 'error' && errorMessage ? (
                  <div className="mt-1 flex items-start gap-2 rounded border border-[#6b2b2b] bg-[#2b1d1d] p-2">
                    <XCircle size={15} className="mt-0.5 shrink-0 text-app-danger" />
                    <p data-testid="export-error" className="break-words text-2xs leading-relaxed text-[#ffb4b4]">
                      {errorMessage}
                    </p>
                  </div>
                ) : null}
              </section>
            ) : null}

            {warnings.length ? (
              <section className="flex flex-col gap-1 rounded border border-[#5d4a20] bg-[#2b2417] p-2.5">
                <header className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-app-warning">
                  <AlertTriangle size={12} /> Warnings ({warnings.length})
                </header>
                <ul className="flex flex-col gap-1">
                  {warnings.map((warning) => (
                    <li key={warning} className="text-2xs leading-relaxed text-[#e5c98a]">
                      • {warning}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

export default ExportDialog;
