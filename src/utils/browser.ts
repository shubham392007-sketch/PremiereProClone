/** Browser capability detection shared by import, playback and export. */

export interface BrowserCapabilities {
  webCodecs: boolean;
  videoEncoder: boolean;
  audioEncoder: boolean;
  opfs: boolean;
  mediaRecorder: boolean;
  canDecodeH264: boolean | null;
  canEncodeH264: boolean | null;
  canEncodeAac: boolean | null;
  storageEstimate: { usage: number; quota: number } | null;
}

export function hasWebCodecs(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === 'function';
}

export function hasAudioEncoder(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { AudioEncoder?: unknown }).AudioEncoder === 'function';
}

export async function detectCapabilities(): Promise<BrowserCapabilities> {
  const caps: BrowserCapabilities = {
    webCodecs: hasWebCodecs(),
    videoEncoder: hasWebCodecs(),
    audioEncoder: hasAudioEncoder(),
    opfs:
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof (navigator.storage as StorageManager & { getDirectory?: () => unknown }).getDirectory === 'function',
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    canDecodeH264: null,
    canEncodeH264: null,
    canEncodeAac: null,
    storageEstimate: null,
  };

  if (caps.videoEncoder) {
    try {
      const videoEncoder = (window as unknown as {
        VideoEncoder: {
          isConfigSupported: (config: unknown) => Promise<{ supported?: boolean }>;
        };
      }).VideoEncoder;
      const h264 = await videoEncoder.isConfigSupported({
        codec: 'avc1.42001f',
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
        framerate: 30,
      });
      caps.canEncodeH264 = Boolean(h264.supported);
      caps.canDecodeH264 = null;
    } catch {
      caps.canEncodeH264 = false;
    }
  }

  if (caps.audioEncoder) {
    try {
      const audioEncoder = (window as unknown as {
        AudioEncoder: {
          isConfigSupported: (config: unknown) => Promise<{ supported?: boolean }>;
        };
      }).AudioEncoder;
      const aac = await audioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 192_000,
      });
      caps.canEncodeAac = Boolean(aac.supported);
    } catch {
      caps.canEncodeAac = false;
    }
  }

  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      caps.storageEstimate = { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
    }
  } catch {
    /* not fatal */
  }

  return caps;
}

export function isSecureEnoughForOpfs(): boolean {
  return typeof window !== 'undefined' && (window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
}

/** Human readable warnings for the project home screen. */
export function compatibilityWarnings(caps: BrowserCapabilities): string[] {
  const warnings: string[] = [];
  if (!caps.webCodecs) warnings.push('WebCodecs is unavailable — MP4 export will fall back to a WebM MediaRecorder capture where possible.');
  else if (caps.canEncodeH264 === false) warnings.push('H.264 encoding is unavailable in this browser — export may use VP9 in an MP4 container or WebM fallback.');
  if (!caps.opfs) warnings.push('OPFS is unavailable — large media files will be stored in IndexedDB instead.');
  return warnings;
}
