/**
 * Timeline audio mixdown for export.
 *
 * Every audible clip inside the export range is decoded once, then scheduled
 * into an `OfflineAudioContext` at the correct timeline offset with its source
 * trim, playback rate, gain, fades and track mute/solo state. The rendered
 * `AudioBuffer` is then handed to the audio encoder (or to the MediaRecorder
 * fallback).
 */
import type { Sequence, TimelineClip, Track } from '@/types';
import { clipEnd, getAudioTracks, getVideoTracks } from '@/engine/timeline/operations';
import { clipGainAtLocalFrame, effectiveTrackGain } from '@/utils/audio';
import { frameToSeconds } from '@/utils/time';
import { ExportCancelledError, type ExportRange } from './types';
import type { ExportMediaResolver, WarningCollector } from './media-sources';

export interface MixAudioOptions {
  sequence: Sequence;
  range: ExportRange;
  sampleRate: number;
  resolver: ExportMediaResolver;
  warnings: WarningCollector;
  shouldCancel?: () => boolean;
  /** reports decoded source count / total sources (real work) */
  onDecodeProgress?: (done: number, total: number) => void;
}

interface ScheduledClip {
  clip: TimelineClip;
  track: Track;
  /** multiplier from track mute / solo / enabled */
  trackFactor: number;
}

interface GainPoint {
  time: number;
  value: number;
}

/**
 * Collect clips that can contribute audio in the requested range. Video-track
 * clips are included when their source has audio; audio-track clips always
 * count. A video clip is skipped when a matching audio-track clip already
 * carries the same media/time span (linked A/V pairs would otherwise double up).
 */
function collectAudioClips(sequence: Sequence, range: ExportRange): ScheduledClip[] {
  const result: ScheduledClip[] = [];
  const inRange = (clip: TimelineClip): boolean =>
    clip.startFrame < range.endFrameExclusive && clipEnd(clip) > range.startFrame;

  const audioTracks = getAudioTracks(sequence);
  const audioIdentities = new Set<string>();
  for (const track of audioTracks) {
    for (const clip of sequence.clips) {
      if (clip.trackId !== track.id || !inRange(clip)) continue;
      audioIdentities.add(`${clip.mediaId}|${clip.startFrame}|${clip.durationFrames}`);
    }
  }

  for (const track of audioTracks) {
    // effectiveTrackGain already folds in mute / solo / enabled state.
    const trackFactor = effectiveTrackGain(sequence, track);
    if (trackFactor <= 0) continue;
    for (const clip of sequence.clips) {
      if (clip.trackId !== track.id || !clip.enabled || !inRange(clip)) continue;
      result.push({ clip, track, trackFactor });
    }
  }

  for (const track of getVideoTracks(sequence)) {
    const trackFactor = track.muted || !track.enabled ? 0 : 1;
    if (trackFactor <= 0) continue;
    for (const clip of sequence.clips) {
      if (clip.trackId !== track.id || !clip.enabled || !inRange(clip)) continue;
      const identity = `${clip.mediaId}|${clip.startFrame}|${clip.durationFrames}`;
      if (audioIdentities.has(identity)) continue;
      result.push({ clip, track, trackFactor });
    }
  }

  return result;
}

function dedupeGainPoints(points: GainPoint[]): GainPoint[] {
  const sorted = [...points].sort((a, b) => a.time - b.time || a.value - b.value);
  const cleaned: GainPoint[] = [];
  for (const point of sorted) {
    const safe: GainPoint = { time: Math.max(0, point.time), value: Math.max(0, point.value) };
    const previous = cleaned[cleaned.length - 1];
    if (previous && Math.abs(previous.time - safe.time) < 1e-6) {
      previous.value = safe.value;
      continue;
    }
    cleaned.push(safe);
  }
  return cleaned;
}

/**
 * Schedule one clip into the offline mix graph. Returns false when the clip has
 * no usable portion inside the range.
 */
function scheduleClip(
  ctx: OfflineAudioContext,
  entry: ScheduledClip,
  buffer: AudioBuffer,
  sequence: Sequence,
  range: ExportRange,
): boolean {
  const { clip } = entry;
  const frameRate = sequence.frameRate;
  const visibleStartFrame = Math.max(clip.startFrame, range.startFrame);
  const visibleEndFrame = Math.min(clipEnd(clip), range.endFrameExclusive);
  if (visibleEndFrame <= visibleStartFrame) return false;

  const localStartFrame = visibleStartFrame - clip.startFrame;
  const localEndFrame = localStartFrame + (visibleEndFrame - visibleStartFrame);
  const outputStartSeconds = frameToSeconds(visibleStartFrame - range.startFrame, frameRate);
  const sourceOffsetSeconds = frameToSeconds(
    clip.sourceInFrame + localStartFrame * clip.playbackRate,
    frameRate,
  );
  const sourceDurationSeconds = frameToSeconds(
    Math.max(0, localEndFrame - localStartFrame) * clip.playbackRate,
    frameRate,
  );
  if (sourceDurationSeconds <= 0 || sourceOffsetSeconds >= buffer.duration) return false;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const rate = clip.playbackRate > 0 ? clip.playbackRate : 1;
  source.playbackRate.value = rate;

  const gainNode = ctx.createGain();
  const points: GainPoint[] = [];
  const pushPoint = (localFrame: number): void => {
    const time = outputStartSeconds + frameToSeconds(localFrame - localStartFrame, frameRate);
    const value = clipGainAtLocalFrame(clip, localFrame) * entry.trackFactor;
    points.push({ time, value });
  };

  pushPoint(localStartFrame);
  const fadeIn = clip.audio.fadeInFrames;
  if (fadeIn > 0) pushPoint(Math.min(fadeIn, localEndFrame));
  const fadeOut = clip.audio.fadeOutFrames;
  if (fadeOut > 0) pushPoint(Math.max(localStartFrame, clip.durationFrames - fadeOut));
  pushPoint(localEndFrame);

  const cleaned = dedupeGainPoints(points);
  if (!cleaned.length) return false;
  const param = gainNode.gain;
  param.setValueAtTime(cleaned[0].value, cleaned[0].time);
  for (let i = 1; i < cleaned.length; i += 1) {
    const point = cleaned[i];
    const previous = cleaned[i - 1];
    if (point.time <= previous.time + 1e-6) continue;
    param.linearRampToValueAtTime(point.value, point.time);
  }

  source.connect(gainNode);
  gainNode.connect(ctx.destination);
  try {
    source.start(Math.max(0, outputStartSeconds), Math.max(0, sourceOffsetSeconds), Math.max(0, sourceDurationSeconds));
  } catch {
    return false;
  }
  return true;
}

/**
 * Decode and mix every audible clip in the export range.
 *
 * Always returns an `AudioBuffer` of the full export duration (silence when no
 * audio clips are audible) so the exported container can keep a valid audio
 * track.
 */
export async function mixSequenceAudio(options: MixAudioOptions): Promise<AudioBuffer> {
  const { sequence, range, sampleRate, resolver, warnings } = options;
  const durationSeconds = Math.max(0.01, range.durationSeconds);
  const bufferLength = Math.max(1, Math.ceil(durationSeconds * sampleRate));

  // Offline contexts keep this path working without needing a user gesture.
  const decodeContext = new OfflineAudioContext(2, 128, sampleRate);
  const mixContext = new OfflineAudioContext(2, bufferLength, sampleRate);
  const decodedBuffers = new Map<string, AudioBuffer | null>();

  const clips = collectAudioClips(sequence, range);
  const mediaIds = [...new Set(clips.map((entry) => entry.clip.mediaId))];
  let decodedCount = 0;

  for (const mediaId of mediaIds) {
    if (options.shouldCancel?.()) throw new ExportCancelledError();
    const asset = resolver.asset(mediaId);
    if (!asset) {
      decodedBuffers.set(mediaId, null);
      continue;
    }
    if (asset.kind === 'image' || !asset.hasAudio) {
      decodedBuffers.set(mediaId, null);
      continue;
    }
    if (resolver.isMissing(mediaId)) {
      warnings.add(`Audio from "${asset.name}" is unavailable (offline media); its clips are silent in the export.`);
      decodedBuffers.set(mediaId, null);
      continue;
    }
    try {
      const data = await resolver.arrayBufferFor(mediaId);
      if (!data || data.byteLength === 0) throw new Error('Empty audio data');
      const audioBuffer = await decodeContext.decodeAudioData(data);
      decodedBuffers.set(mediaId, audioBuffer);
    } catch {
      warnings.add(`Audio from "${asset.name}" could not be decoded; its clips are silent in the export.`);
      decodedBuffers.set(mediaId, null);
    }
    decodedCount += 1;
    options.onDecodeProgress?.(decodedCount, mediaIds.length);
  }

  let scheduled = 0;
  for (const entry of clips) {
    const buffer = decodedBuffers.get(entry.clip.mediaId);
    if (!buffer) continue;
    if (scheduleClip(mixContext, entry, buffer, sequence, range)) scheduled += 1;
  }
  if (!scheduled && clips.length > 0) {
    warnings.add('No audible audio clips were found in the export range; the exported audio track will be silent.');
  }
  const rendered = await mixContext.startRendering();
  return rendered;
}
