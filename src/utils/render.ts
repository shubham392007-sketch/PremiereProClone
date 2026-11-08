import type { VideoTransform } from '@/types';

/**
 * Draw one composited source frame into a sequence-sized destination context.
 * The source is fitted (contain) to the sequence frame, then the clip's
 * scale/rotation/position/opacity transform is applied. Clip x/y are expressed
 * in sequence pixels relative to the center.
 */
export function drawTransformedFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
  transform: VideoTransform,
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0 || outWidth <= 0 || outHeight <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, transform.opacity));
  ctx.translate(outWidth / 2 + transform.x, outHeight / 2 + transform.y);
  if (transform.rotation) ctx.rotate((transform.rotation * Math.PI) / 180);
  const scale = Math.max(0.001, transform.scale);
  ctx.scale(scale, scale);
  const fit = Math.min(outWidth / sourceWidth, outHeight / sourceHeight);
  const drawWidth = sourceWidth * fit;
  const drawHeight = sourceHeight * fit;
  ctx.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
}

/** Fit a sequence aspect ratio inside a container box. */
export function fitBox(
  containerWidth: number,
  containerHeight: number,
  aspectWidth: number,
  aspectHeight: number,
): { width: number; height: number } {
  if (containerWidth <= 0 || containerHeight <= 0) return { width: 0, height: 0 };
  const containerAspect = containerWidth / containerHeight;
  const contentAspect = aspectWidth / aspectHeight;
  if (containerAspect > contentAspect) {
    return { width: containerHeight * contentAspect, height: containerHeight };
  }
  return { width: containerWidth, height: containerWidth / contentAspect };
}

export function blackFrame(width: number, height: number): { width: number; height: number } {
  return { width, height };
}
