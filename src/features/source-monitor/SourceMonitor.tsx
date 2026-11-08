/**
 * Source monitor: previews a project media asset with real playback.
 *
 * Video and audio are played through actual HTML media elements (object URL
 * from the media runtime store); images are displayed directly. The monitor is
 * frame-accurate against the active sequence's frame rate because source In/Out
 * marks and inserted ranges are expressed in sequence frames.
 */
import { useMemo, useRef, type CSSProperties, type DragEvent } from 'react';
import {
  AlertTriangle,
  Link2,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { IconButton } from '@/components/common/IconButton';
import { EmptyState, Spinner } from '@/components/common/EmptyState';
import { findSequence } from '@/engine/timeline/factory';
import { useMediaStore } from '@/stores/media-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { useProjectStore } from '@/stores/project-store';
import { frameToTimecode } from '@/utils/time';
import { useSourceTransport } from './useSourceTransport';
import { SourceSeekBar } from './SourceSeekBar';
import { SourceWaveform } from './SourceWaveform';

const FALLBACK_FPS = { num: 30, den: 1, label: '30' };
const MEDIA_DRAG_TYPE = 'application/x-premiere-media';

export function SourceMonitor() {
  const project = useProjectStore((s) => s.project);
  const source = usePlaybackStore((s) => s.source);
  const setSourceScale = usePlaybackStore((s) => s.setSourceScale);
  const setSourceMuted = usePlaybackStore((s) => s.setSourceMuted);
  const closeSource = usePlaybackStore((s) => s.closeSource);
  const mediaUrl = useMediaStore((s) => (source.mediaId ? s.urls[source.mediaId] : undefined));

  const sequence = project ? findSequence(project) : undefined;
  const fps = sequence?.frameRate ?? FALLBACK_FPS;
  const media = source.mediaId && project ? project.media.find((asset) => asset.id === source.mediaId) : undefined;
  const transport = useSourceTransport(media, fps, mediaUrl);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const ready = Boolean(media && mediaUrl && !media.missing);
  const durationFrames = media ? transport.durationFrames : 0;
  const progress = durationFrames > 0 ? Math.min(1, source.currentFrame / durationFrames) : 0;
  const hasMarks = source.inFrame !== null || source.outFrame !== null;
  const scaleValue = source.scale === 'fit' ? 'fit' : String(source.scale);

  const scaleStyle = useMemo<CSSProperties>(() => {
    if (!media || media.kind === 'audio' || source.scale === 'fit') return {};
    const factor = typeof source.scale === 'number' ? source.scale : 1;
    if (media.width > 0 && media.height > 0) {
      return {
        width: Math.max(1, Math.round(media.width * factor)),
        height: Math.max(1, Math.round(media.height * factor)),
        maxWidth: 'none',
        maxHeight: 'none',
      };
    }
    return {};
  }, [media, source.scale]);

  const handlePreviewDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (!media || media.missing) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(MEDIA_DRAG_TYPE, media.id);
    event.dataTransfer.setData('text/plain', media.id);
    event.dataTransfer.effectAllowed = 'copy';
  };

  const focusMonitor = () => {
    rootRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={rootRef}
      data-monitor="source"
      data-testid="source-monitor"
      tabIndex={0}
      className="flex h-full min-h-0 flex-col bg-app-panel outline-none"
    >
      {/* header: name / resolution / fps */}
      <div className="flex h-[30px] shrink-0 items-center gap-1.5 overflow-hidden border-b border-app-border bg-app-panel2 px-2">
        <MonitorPlay size={13} className="shrink-0 text-app-textDim" />
        <span
          className="min-w-0 flex-1 truncate text-2xs font-medium text-app-text"
          title={media?.name ?? 'Source Monitor'}
        >
          {media?.name ?? 'Source Monitor'}
        </span>
        {media ? (
          <span className="max-w-[48%] shrink-0 truncate text-3xs text-app-textFaint">
            {media.kind === 'audio'
              ? 'Audio'
              : `${media.width || '?'} × ${media.height || '?'}`}
            {media.kind === 'video' ? ` · ${media.fps?.label ?? fps.label} fps` : ''}
            {media.hasAudio && media.kind !== 'audio' ? ' · audio' : ''}
          </span>
        ) : null}
        {media?.missing ? (
          <span className="shrink-0 rounded-[2px] border border-[#6b2b2b] px-1 text-3xs uppercase tracking-wide text-[#ff9b9b]">
            Offline
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            icon={X}
            label="Close Source Monitor"
            size={20}
            iconSize={11}
            onClick={closeSource}
            disabled={!media}
          />
        </div>
      </div>

      {/* preview */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
        onMouseDown={focusMonitor}
        onDragStart={handlePreviewDragStart}
        draggable={Boolean(media && !media.missing)}
        title={media ? 'Drag to the timeline to insert this clip' : undefined}
      >
        {!media ? (
          <EmptyState
            icon={MonitorPlay}
            title="No clip loaded"
            description="Double-click a clip in the Project panel to open it here. Drag from this monitor to insert it into the timeline."
          />
        ) : media.missing ? (
          <EmptyState
            icon={AlertTriangle}
            title="Media is offline"
            description={`"${media.name}" could not be found in local storage. Use Relink Media in the Project panel to choose the file again.`}
          />
        ) : !mediaUrl ? (
          <div className="flex flex-col items-center gap-2">
            <Spinner size={18} />
            <p className="text-2xs text-app-textDim">Preparing preview…</p>
          </div>
        ) : media.kind === 'video' ? (
          <video
            ref={transport.videoRef}
            src={mediaUrl}
            poster={media.thumbnailDataUrl}
            className="pointer-events-none max-h-full max-w-full object-contain"
            style={scaleStyle}
            playsInline
            preload="auto"
            muted={source.muted}
            draggable={false}
            onLoadedMetadata={transport.syncElement}
            onEnded={transport.handleEnded}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : media.kind === 'audio' ? (
          <>
            <audio
              ref={transport.audioRef}
              src={mediaUrl}
              className="hidden"
              preload="auto"
              muted={source.muted}
              onLoadedMetadata={transport.syncElement}
              onEnded={transport.handleEnded}
            />
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4">
              <SourceWaveform peaks={media.waveformPeaks} progress={progress} />
              <p className="max-w-[560px] truncate text-2xs text-app-textFaint" title={media.name}>
                {media.name}
              </p>
            </div>
          </>
        ) : (
          <img
            src={mediaUrl}
            alt={media.name}
            className="pointer-events-none max-h-full max-w-full object-contain"
            style={scaleStyle}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
          />
        )}
      </div>

      {/* transport */}
      {media ? (
        <div className="shrink-0 border-t border-app-border bg-app-panel px-2 pb-1 pt-1">
          <div className="flex items-center gap-2 pb-0.5">
            <span className="timecode shrink-0 text-2xs text-app-text">
              {frameToTimecode(source.currentFrame, fps)}
            </span>
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {source.inFrame !== null ? (
                <span className="shrink-0 rounded-[2px] bg-[#3a2f18] px-1 text-3xs text-[#e5b75a]">
                  In {frameToTimecode(source.inFrame, fps)}
                </span>
              ) : null}
              {source.outFrame !== null ? (
                <span className="shrink-0 rounded-[2px] bg-[#3a2f18] px-1 text-3xs text-[#e5b75a]">
                  Out {frameToTimecode(source.outFrame, fps)}
                </span>
              ) : null}
            </span>
            <span className="ml-auto timecode shrink-0 text-2xs text-app-textFaint">
              {frameToTimecode(durationFrames, fps)}
            </span>
          </div>
          <SourceSeekBar
            durationFrames={durationFrames}
            currentFrame={source.currentFrame}
            inFrame={source.inFrame}
            outFrame={source.outFrame}
            disabled={!ready}
            onSeek={transport.seekFrame}
            onScrubStart={transport.pause}
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton
                icon={SkipBack}
                label="Go to start"
                shortcut="Home"
                size={22}
                iconSize={13}
                disabled={!ready}
                onClick={() => transport.seekFrame(0)}
              />
            <IconButton
              icon={StepBack}
              label="Step back one frame"
              size={22}
              iconSize={13}
              disabled={!ready}
              onClick={() => transport.step(-1)}
            />
            <IconButton
              icon={source.playing ? Pause : Play}
              label={source.playing ? 'Pause' : 'Play'}
              shortcut="Space"
              size={26}
              iconSize={15}
              active={source.playing}
              disabled={!ready}
              onClick={transport.toggle}
            />
            <IconButton
              icon={StepForward}
              label="Step forward one frame"
              size={22}
              iconSize={13}
              disabled={!ready}
              onClick={() => transport.step(1)}
            />
              <IconButton
                icon={SkipForward}
                label="Go to end"
                size={22}
                iconSize={13}
                disabled={!ready}
                onClick={() => transport.seekFrame(durationFrames)}
              />
            </div>
            <div className="mx-0.5 h-5 w-px shrink-0 bg-app-border" />
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                data-testid="source-mark-in"
                className="tool-btn h-6 px-1.5 text-2xs"
                onClick={transport.markIn}
                disabled={!ready}
                title="Mark In (I)"
              >
                In
              </button>
              <button
                type="button"
                data-testid="source-mark-out"
                className="tool-btn h-6 px-1.5 text-2xs"
                onClick={transport.markOut}
                disabled={!ready}
                title="Mark Out (O)"
              >
                Out
              </button>
              <button
                type="button"
                data-testid="source-clear-marks"
                className="tool-btn h-6 px-1.5 text-2xs"
                onClick={transport.clearMarks}
                disabled={!ready || !hasMarks}
                title="Clear In/Out marks"
              >
                Clear
              </button>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <IconButton
                icon={source.muted ? VolumeX : Volume2}
                label={source.muted ? 'Unmute source audio' : 'Mute source audio'}
                size={22}
                iconSize={13}
                active={!source.muted}
                onClick={() => setSourceMuted(!source.muted)}
              />
              <select
                className="select h-6 w-[62px] shrink-0 text-2xs"
                value={scaleValue}
                onChange={(event) => {
                  const value = event.target.value;
                  setSourceScale(value === 'fit' ? 'fit' : Number(value));
                }}
                title="Preview scale"
                aria-label="Preview scale"
              >
                <option value="fit">Fit</option>
                <option value="0.5">50%</option>
                <option value="1">100%</option>
              </select>
              <button
                type="button"
                data-testid="source-insert"
                className="btn h-6 shrink-0 gap-1 px-2 text-2xs"
                onClick={transport.insertIntoSequence}
                disabled={!ready}
                title="Insert marked range into the timeline at the playhead (whole clip when unmarked)"
              >
                <Plus size={12} />
                Insert
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-t border-app-border bg-app-panel text-3xs text-app-textFaint">
          <Link2 size={10} />
          Open a clip from the Project panel to enable transport controls
        </div>
      )}
    </div>
  );
}

export default SourceMonitor;
