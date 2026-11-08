/**
 * Sequence frame compositor.
 *
 * Draws one program frame for a sequence: black background, then every video
 * track from the bottom-most (V1) to the top-most. Each track contributes at
 * most one active clip at the requested frame (the same rule the authoritative
 * timeline model uses), and that clip's transform/opacity is applied with the
 * shared `drawTransformedFrame` helper so the Program Monitor and export see
 * the same geometry.
 *
 * The compositor is intentionally free of DOM/engine state so the playback
 * engine and a future export pipeline can reuse it.
 */

import type { MediaAsset, PreviewQuality, Sequence, TimelineClip } from '@/types';
import { clipAtFrame, getVideoTracks } from '@/engine/timeline/operations';
import { drawTransformedFrame } from '@/utils/render';

/** Internal render divisor for each preview quality setting. */
export const PREVIEW_QUALITY_DIVISOR: Record<PreviewQuality, number> = {
  full: 1,
  half: 2,
  quarter: 4,
};

export function previewQualityDivisor(quality: PreviewQuality): number {
  return PREVIEW_QUALITY_DIVISOR[quality] ?? 1;
}

/** A decodable picture ready to be drawn into the canvas. */
export interface CompositeSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface CompositeFrameProvider {
  /** Project media lookup (undefined when the media was removed). */
  getMediaAsset(mediaId: string): MediaAsset | undefined;
  /** False when the media exists in the project but has no runtime blob URL. */
  hasMediaSource(mediaId: string): boolean;
  /** Picture for the clip, or null while the decoder/image is not ready. */
  getFrameSource(clip: TimelineClip, asset: MediaAsset): CompositeSource | null;
}

export interface OfflineClipInfo {
  clip: TimelineClip;
  /** Friendly name for the offline media / clip. */
  name: string;
}

export interface CompositeFrameReport {
  /** Number of clips that contributed pixels. */
  drawnClips: number;
  /** Active clips skipped because the media is offline / unavailable. */
  offlineClips: OfflineClipInfo[];
  /** Active clips whose source has not decoded a frame yet. */
  unreadyClips: number;
}

/**
 * Composite `frame` of `sequence` into `ctx`.
 *
 * @param context 2D context whose canvas is already sized to the preview
 *                resolution (sequence size / divisor).
 * @param divisor Internal quality divisor (1, 2 or 4). Clip x/y offsets are
 *                in sequence pixels, so they are divided to match the canvas.
 */
export function compositeSequenceFrame(
  context: CanvasRenderingContext2D,
  sequence: Sequence,
  frame: number,
  provider: CompositeFrameProvider,
  divisor = 1,
): CompositeFrameReport {
  const width = context.canvas.width;
  const height = context.canvas.height;
  const report: CompositeFrameReport = { drawnClips: 0, offlineClips: [], unreadyClips: 0 };

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.restore();

  if (width < 2 || height < 2) return report;

  const safeFrame = Math.max(0, Math.floor(frame));
  const safeDivisor = Math.max(0.0001, divisor);

  for (const track of getVideoTracks(sequence)) {
    // Hidden/disabled video tracks never reach the program output.
    if (track.hidden || !track.enabled) continue;

    const clip = clipAtFrame(sequence, track.id, safeFrame);
    if (!clip || !clip.enabled) continue;

    const asset = provider.getMediaAsset(clip.mediaId);
    const available = Boolean(asset) && !asset?.missing && provider.hasMediaSource(clip.mediaId);

    if (!available) {
      report.offlineClips.push({
        clip,
        name: clip.name?.trim() || asset?.name || 'Missing media',
      });
      drawOfflinePlaceholder(context, sequence, clip, asset ?? undefined, safeDivisor);
      continue;
    }

    const source = provider.getFrameSource(clip, asset as MediaAsset);
    if (!source) {
      report.unreadyClips += 1;
      continue;
    }

    drawTransformedFrame(context, source.image, source.width, source.height, width, height, {
      // The canvas may be downscaled by the preview quality divisor; clip
      // positions are stored in sequence pixels and must follow.
      x: clip.transform.x / safeDivisor,
      y: clip.transform.y / safeDivisor,
      scale: clip.transform.scale,
      rotation: clip.transform.rotation,
      opacity: clip.transform.opacity,
    });
    report.drawnClips += 1;
  }

  return report;
}

/** Draw an informative "media offline" slate for a clip that cannot decode. */
function drawOfflinePlaceholder(
  context: CanvasRenderingContext2D,
  sequence: Sequence,
  clip: TimelineClip,
  asset: MediaAsset | undefined,
  divisor: number,
): void {
  const width = context.canvas.width;
  const height = context.canvas.height;
  if (width < 4 || height < 4) return;

  const transform = clip.transform;
  const scale = Math.max(0.01, transform.scale);

  context.save();
  context.globalAlpha = Math.min(1, Math.max(0, transform.opacity));
  context.translate(width / 2 + transform.x / divisor, height / 2 + transform.y / divisor);
  if (transform.rotation) context.rotate((transform.rotation * Math.PI) / 180);
  context.scale(scale, scale);

  const aspect =
    asset && asset.width > 0 && asset.height > 0
      ? asset.width / asset.height
      : Math.max(0.2, sequence.width / Math.max(1, sequence.height));

  // Slate sized relative to the output frame (but never larger than the frame).
  let boxWidth = width * 0.42;
  let boxHeight = boxWidth / aspect;
  const maxHeight = height * 0.62;
  if (boxHeight > maxHeight) {
    boxHeight = maxHeight;
    boxWidth = boxHeight * aspect;
  }
  if (boxWidth > width * 0.9) {
    boxWidth = width * 0.9;
    boxHeight = boxWidth / aspect;
  }

  const left = -boxWidth / 2;
  const top = -boxHeight / 2;
  const unit = Math.max(1, height / 360);

  context.fillStyle = 'rgba(18, 18, 18, 0.94)';
  context.fillRect(left, top, boxWidth, boxHeight);

  context.strokeStyle = '#a04545';
  context.lineWidth = unit;
  context.setLineDash([5 * unit, 4 * unit]);
  context.strokeRect(left, top, boxWidth, boxHeight);
  context.setLineDash([]);

  const titleSize = Math.max(9, Math.round(boxHeight * 0.075));
  const subSize = Math.max(8, Math.round(boxHeight * 0.052));
  const label = clip.name?.trim() || asset?.name || 'Missing media';
  const truncated = label.length > 36 ? `${label.slice(0, 33)}…` : label;

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#e8b4b4';
  context.font = `600 ${titleSize}px Inter, 'Segoe UI', system-ui, sans-serif`;
  context.fillText('MEDIA OFFLINE', 0, -titleSize * 0.7);

  context.fillStyle = '#a0a0a0';
  context.font = `${subSize}px Inter, 'Segoe UI', system-ui, sans-serif`;
  context.fillText(truncated, 0, titleSize * 0.9);

  context.restore();
}
