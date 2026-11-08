import type { MediaAsset, Sequence, TimelineClip } from '@/types';

/** Seconds into the source media for a given absolute timeline frame. */
export function sourceSecondsForTimelineFrame(
  clip: TimelineClip,
  timelineFrame: number,
  sequence: Sequence,
): number {
  const local = (timelineFrame - clip.startFrame) * clip.playbackRate;
  const sourceFrame = clip.sourceInFrame + local;
  return (sourceFrame * sequence.frameRate.den) / sequence.frameRate.num;
}

/** Seconds into the source media for a clip-local frame. */
export function sourceSecondsForLocalFrame(
  clip: TimelineClip,
  localFrame: number,
  sequence: Sequence,
): number {
  const sourceFrame = clip.sourceInFrame + localFrame * clip.playbackRate;
  return (sourceFrame * sequence.frameRate.den) / sequence.frameRate.num;
}

/** Maximum clip duration in timeline frames given the media duration. */
export function maxDurationFramesForAsset(asset: MediaAsset | undefined, sequence: Sequence): number {
  if (!asset || asset.kind === 'image') return Number.MAX_SAFE_INTEGER;
  const fps = sequence.frameRate.num / sequence.frameRate.den;
  return Math.max(1, Math.floor(asset.durationSec * fps));
}

/** Format frame count as a clip duration label `HH:MM:SS:FF` is handled in time utils. */
export function mediaDisplaySize(asset: MediaAsset | undefined): string {
  if (!asset) return '—';
  if (asset.kind === 'audio') return asset.hasAudio ? 'Audio' : 'Audio';
  if (asset.width && asset.height) return `${asset.width} × ${asset.height}`;
  return '—';
}
