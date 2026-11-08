/**
 * Program Monitor ("Program:" panel).
 *
 * Shows the real composited sequence output rendered by
 * `ProgramPlaybackEngine`: V1→Vn video tracks with transforms/opacity, images,
 * black gaps, synchronized clip audio, offline/decode cues and full transport.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Film,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  WifiOff,
} from 'lucide-react';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/utils/format';
import { findSequence } from '@/engine/timeline/factory';
import { useProjectStore } from '@/stores/project-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { notify } from '@/stores/workspace-store';
import { frameToTimecode, sequenceDurationFrames } from '@/utils/time';
import { fitBox } from '@/utils/render';
import { PREVIEW_QUALITIES } from '@/utils/presets';
import { registerProgramPlayback } from '@/engine/playback/registry';
import {
  ProgramPlaybackEngine,
  type ProgramEngineStatus,
} from '@/engine/playback/ProgramPlaybackEngine';
import type { FrameRate, PreviewQuality } from '@/types';

const FALLBACK_FPS: FrameRate = { num: 30, den: 1, label: '30' };

const RATE_OPTIONS: Array<{ rate: number; label: string; hint: string }> = [
  { rate: -1, label: '-1×', hint: 'Play backwards (frame-stepped reverse) — J' },
  { rate: 1, label: '1×', hint: 'Normal speed — L (K pauses)' },
  { rate: 2, label: '2×', hint: 'Double speed — press L twice' },
  { rate: 4, label: '4×', hint: 'Four times speed — press L three times' },
];

const SCALE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: '25', label: '25%' },
  { value: '50', label: '50%' },
  { value: '100', label: '100%' },
  { value: '200', label: '200%' },
];

function statusLabel(status: ProgramEngineStatus | null, hasSequence: boolean): string {
  if (!hasSequence) return 'No sequence';
  if (!status) return 'Ready';
  if (status.playing) {
    if (status.rate < 0) return 'Reverse (frame-step)';
    return status.rate === 1 ? 'Playing' : `Playing ${status.rate}×`;
  }
  if (status.offlineNames.length > 0) return 'Offline media';
  return 'Paused';
}

export function ProgramMonitor() {
  const project = useProjectStore((state) => state.project);
  const sequence = useMemo(
    () => (project ? findSequence(project) ?? project.sequences[0] ?? null : null),
    [project],
  );

  const currentFrame = usePlaybackStore((state) => state.currentFrame);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const rate = usePlaybackStore((state) => state.rate);
  const loop = usePlaybackStore((state) => state.loop);
  const programScale = usePlaybackStore((state) => state.programScale);
  const programQuality = usePlaybackStore((state) => state.programQuality);
  const setLoop = usePlaybackStore((state) => state.setLoop);
  const setProgramScale = usePlaybackStore((state) => state.setProgramScale);
  const setProgramQuality = usePlaybackStore((state) => state.setProgramQuality);

  const engineRef = useRef<ProgramPlaybackEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousBlockedRef = useRef(false);

  const [status, setStatus] = useState<ProgramEngineStatus | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  /* engine lifecycle: attach canvas, register global playback api, clean up */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new ProgramPlaybackEngine();
    engineRef.current = engine;
    const unsubscribe = engine.subscribeStatus(setStatus);
    engine.attach(canvas);
    registerProgramPlayback({
      play: () => engine.play(),
      pause: () => engine.pause(),
      toggle: () => engine.toggle(),
      seek: (frame, options) => engine.seek(frame, options),
      step: (delta) => engine.step(delta),
      jumpToStart: () => engine.jumpToStart(),
      jumpToEnd: () => engine.jumpToEnd(),
      setRate: (nextRate) => engine.setRate(nextRate),
      isReady: () => engine.isReady(),
    });
    return () => {
      registerProgramPlayback(null);
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Autoplay policies can reject the first play() until a fresh gesture.
  useEffect(() => {
    const blocked = Boolean(status?.autoplayBlocked);
    if (blocked && !previousBlockedRef.current) {
      notify(
        'warning',
        'Browser blocked audio playback',
        'Playback continues silently. Click "Enable audio" in the Program Monitor to hear sound.',
      );
    }
    previousBlockedRef.current = blocked;
  }, [status?.autoplayBlocked]);

  // Track the fitted display size so the canvas CSS box always matches aspect.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setViewportSize({ width: rect.width, height: rect.height });
      engineRef.current?.redraw();
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    setViewportSize({ width: rect.width, height: rect.height });
    return () => observer.disconnect();
  }, []);

  // Fullscreen tracking.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const frameRate = sequence?.frameRate ?? FALLBACK_FPS;
  const durationFrames = sequence ? sequenceDurationFrames(sequence) : 0;
  const maxFrame = Math.max(0, durationFrames - 1);
  const playhead = Math.max(0, Math.min(maxFrame, currentFrame));
  const sequenceWidth = sequence?.width ?? 1920;
  const sequenceHeight = sequence?.height ?? 1080;

  const fitted = fitBox(
    Math.max(0, viewportSize.width - 12),
    Math.max(0, viewportSize.height - 12),
    sequenceWidth,
    sequenceHeight,
  );
  const scalePercent = programScale === 'fit' ? null : programScale;
  const displayWidth = Math.max(1, scalePercent ? (sequenceWidth * scalePercent) / 100 : fitted.width);
  const displayHeight = Math.max(1, scalePercent ? (sequenceHeight * scalePercent) / 100 : fitted.height);

  const transportDisabled = !sequence || durationFrames <= 0;
  const currentTimecode = frameToTimecode(playhead, frameRate);
  const durationTimecode = frameToTimecode(durationFrames, frameRate);
  const label = statusLabel(status, Boolean(sequence));

  const call = (action: (engine: ProgramPlaybackEngine) => void) => {
    const engine = engineRef.current;
    if (engine) action(engine);
  };

  const toggleFullscreen = () => {
    const panel = panelRef.current;
    if (!panel) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void panel.requestFullscreen?.().catch(() => undefined);
  };

  const handleSeek = (frame: number) => {
    const engine = engineRef.current;
    if (engine) {
      engine.seek(frame);
    } else {
      usePlaybackStore.getState().setCurrentFrame(frame);
    }
  };

  return (
    <div
      ref={panelRef}
      data-testid="program-monitor"
      className="panel h-full min-h-0 bg-app-panel"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="panel-header shrink-0 justify-between">
        <div className="flex min-w-0 items-center gap-1.5">
          <Film size={12} className="shrink-0 text-app-textFaint" />
          <span className="truncate text-2xs text-app-textDim">
            Program:{' '}
            <span className="font-medium text-app-text">{sequence?.name ?? 'No sequence'}</span>
          </span>
          {sequence ? (
            <span className="truncate text-3xs text-app-textFaint">
              {sequence.width}×{sequence.height} · {sequence.frameRate.label} fps
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            data-testid="program-status"
            className="flex items-center gap-1 rounded-sm bg-[#1a1a1a] px-1.5 py-0.5 text-3xs text-app-textDim"
            title={label}
          >
            <span
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full',
                !sequence
                  ? 'bg-app-textFaint'
                  : isPlaying
                    ? rate < 0
                      ? 'bg-app-warning'
                      : 'bg-app-success'
                    : 'bg-[#7a7a7a]',
              )}
            />
            {label}
          </span>
          {loop ? <span className="text-3xs text-app-accent">Loop</span> : null}
        </div>
      </div>

      <div
        ref={viewportRef}
        data-testid="program-canvas-container"
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-black p-1.5"
      >
        <div
          className="relative shrink-0 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
          style={{ width: displayWidth, height: displayHeight, aspectRatio: `${sequenceWidth} / ${sequenceHeight}` }}
        >
          <canvas
            ref={canvasRef}
            data-testid="program-canvas"
            className="block h-full w-full bg-black"
          />
          {/* overlays */}
          {!sequence ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 px-4 text-center">
              <Film size={22} className="text-app-textFaint" />
              <p className="text-xs font-medium text-app-textDim">No sequence</p>
              <p className="max-w-[240px] text-2xs leading-relaxed text-app-textFaint">
                Open or create a project to preview the timeline.
              </p>
            </div>
          ) : null}

          {sequence && status && !status.hasClips ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center">
              <Film size={20} className="text-[#5a5a5a]" />
              <p className="text-xs font-medium text-app-textDim">Timeline is empty</p>
              <p className="max-w-[240px] text-2xs leading-relaxed text-app-textFaint">
                Drag media from the Project panel onto the timeline to see it here.
              </p>
            </div>
          ) : null}

          {status && status.unreadyClips > 0 ? (
            <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-3xs text-app-textDim">
              <Loader2 size={10} className="animate-spin-slow" /> Loading media…
            </div>
          ) : null}

          {status && status.offlineNames.length > 0 ? (
            <div
              data-testid="program-offline"
              className="pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[92%] items-center gap-1 rounded-sm border border-[#7a3434] bg-[#3a1d1d]/95 px-1.5 py-0.5 text-3xs text-[#ffb0b0]"
            >
              <WifiOff size={10} className="shrink-0" />
              <span className="truncate">Media offline: {status.offlineNames.join(', ')}</span>
            </div>
          ) : null}

          {status && status.decodeErrors.length > 0 ? (
            <div
              data-testid="program-decode-error"
              className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center gap-1.5 rounded-sm border border-[#7a3434] bg-[#3a1d1d]/95 px-1.5 py-1 text-3xs text-[#ffb0b0]"
            >
              <AlertTriangle size={11} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Cannot decode: {status.decodeErrors.join(', ')}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-sm border border-[#8c4545] px-1 py-0.5 text-3xs text-[#ffd7d7] hover:bg-[#542929]"
                onClick={() => call((engine) => engine.refresh())}
              >
                Retry
              </button>
            </div>
          ) : null}

          {status?.autoplayBlocked ? (
            <div
              data-testid="program-autoplay-blocked"
              className="absolute left-1.5 right-1.5 top-1.5 flex items-center gap-1.5 rounded-sm border border-[#6d5a2a] bg-[#3a2f18]/95 px-1.5 py-1 text-3xs text-[#ffd9a0]"
            >
              <AlertTriangle size={11} className="shrink-0 text-app-warning" />
              <span className="min-w-0 flex-1 truncate">
                Browser blocked audio — playback continues silently.
              </span>
              <button
                type="button"
                className="shrink-0 rounded-sm border border-[#8c7337] px-1 py-0.5 text-3xs text-[#ffe9c4] hover:bg-[#4d3d1f]"
                onClick={() => call((engine) => engine.resumeAudio())}
              >
                Enable audio
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-app-border bg-app-panel2 px-2 pb-1.5 pt-1.5">
        <div className="flex items-center gap-2">
          <span
            data-testid="program-timecode"
            className="timecode w-[86px] shrink-0 text-right text-2xs text-app-text"
            title="Current timecode"
          >
            {currentTimecode}
          </span>
          <input
            data-testid="program-seek-bar"
            type="range"
            min={0}
            max={maxFrame}
            step={1}
            value={playhead}
            disabled={transportDisabled}
            aria-label="Program playhead"
            onChange={(event) => handleSeek(Number(event.target.value))}
            className="h-3 min-w-0 flex-1"
          />
          <span className="timecode w-[86px] shrink-0 text-3xs text-app-textFaint" title="Sequence duration">
            {durationTimecode}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          <IconButton
            icon={SkipBack}
            label="Go to sequence start"
            shortcut="Home"
            data-testid="program-jump-start"
            disabled={transportDisabled}
            onClick={() => call((engine) => engine.jumpToStart())}
          />
          <IconButton
            icon={StepBack}
            label="Previous frame"
            shortcut="Left"
            data-testid="program-prev-frame"
            disabled={transportDisabled}
            onClick={() => call((engine) => engine.step(-1))}
          />
          <IconButton
            icon={isPlaying ? Pause : Play}
            label={isPlaying ? 'Pause' : 'Play'}
            shortcut="Space"
            size={28}
            iconSize={15}
            active={isPlaying}
            data-testid="program-play"
            disabled={transportDisabled}
            onClick={() => call((engine) => engine.toggle())}
          />
          <IconButton
            icon={StepForward}
            label="Next frame"
            shortcut="Right"
            data-testid="program-next-frame"
            disabled={transportDisabled}
            onClick={() => call((engine) => engine.step(1))}
          />
          <IconButton
            icon={SkipForward}
            label="Go to sequence end"
            shortcut="End"
            data-testid="program-jump-end"
            disabled={transportDisabled}
            onClick={() => call((engine) => engine.jumpToEnd())}
          />
          <IconButton
            icon={Repeat}
            label="Loop playback"
            active={loop}
            data-testid="program-loop"
            onClick={() => setLoop(!loop)}
          />

          <div className="divider-v" />

          <div className="flex items-center gap-0.5" role="group" aria-label="Playback speed">
            {RATE_OPTIONS.map((option) => (
              <button
                key={option.rate}
                type="button"
                title={option.hint}
                data-testid={`program-rate-${option.rate}`}
                aria-pressed={rate === option.rate}
                disabled={transportDisabled}
                className={cn(
                  'h-6 min-w-[30px] rounded-[3px] px-1.5 text-2xs tabular-nums transition-colors disabled:opacity-35',
                  rate === option.rate
                    ? 'bg-app-selection text-white'
                    : 'text-app-textDim hover:bg-[#3a3a3a] hover:text-app-text',
                )}
                onClick={() => call((engine) => engine.setRate(option.rate))}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <label className="flex items-center gap-1 text-3xs text-app-textFaint" title="Preview scale">
              Scale
              <select
                data-testid="program-scale"
                className="h-6 rounded-[3px] border border-app-border bg-[#191919] px-1 text-2xs text-app-text outline-none focus:border-app-accent"
                value={programScale === 'fit' ? 'fit' : String(programScale)}
                onChange={(event) => {
                  const value = event.target.value;
                  setProgramScale(value === 'fit' ? 'fit' : Number(value));
                }}
              >
                {SCALE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1 text-3xs text-app-textFaint" title="Preview resolution">
              Quality
              <select
                data-testid="program-quality"
                className="h-6 rounded-[3px] border border-app-border bg-[#191919] px-1 text-2xs text-app-text outline-none focus:border-app-accent"
                value={programQuality}
                onChange={(event) => setProgramQuality(event.target.value as PreviewQuality)}
              >
                {PREVIEW_QUALITIES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <IconButton
              icon={isFullscreen ? Minimize2 : Maximize2}
              label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              shortcut="Shift+`"
              data-testid="program-fullscreen"
              onClick={toggleFullscreen}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Helper for other panels that need the active sequence in a reactive way. */
export default ProgramMonitor;
