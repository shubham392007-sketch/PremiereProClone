/**
 * Web Audio gain graph for program-monitor playback.
 *
 * Media elements created by the playback engine are routed through a
 * `GainNode` so clip gain values above 100% (up to 200%) and per-frame fades
 * can be represented faithfully. `<audio>`/`<video>` `volume` is capped at 1.0,
 * so when Web Audio is unavailable we fall back to element volume and accept
 * that clipping.
 *
 * The context is created lazily. Browsers may start it suspended until a user
 * gesture; `resume()` is called from the engine's play path (which is always
 * triggered by a click or key press).
 */

const MAX_GAIN = 2;

function clampGain(gain: number): number {
  if (!Number.isFinite(gain)) return 0;
  return Math.min(MAX_GAIN, Math.max(0, gain));
}

interface ElementAudioNode {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

export class MediaAudioGraph {
  private context: AudioContext | null = null;
  private unavailable = false;
  private readonly nodes = new Map<HTMLMediaElement, ElementAudioNode>();

  /** True when media elements are routed through Web Audio. */
  get isRouted(): boolean {
    return this.context !== null && !this.unavailable;
  }

  private ensureContext(): AudioContext | null {
    if (this.unavailable) return null;
    if (this.context) return this.context;
    if (typeof window === 'undefined') {
      this.unavailable = true;
      return null;
    }
    const ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctor) {
      this.unavailable = true;
      return null;
    }
    try {
      this.context = new ctor();
      return this.context;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  /** Route an element through the gain graph (idempotent). */
  connect(element: HTMLMediaElement): void {
    if (this.nodes.has(element)) return;
    const context = this.ensureContext();
    if (!context) return;
    try {
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(context.destination);
      this.nodes.set(element, { source, gain });
    } catch {
      // Element may already be connected elsewhere; fall back to el.volume.
    }
  }

  /** Apply a linear gain (0..2) to a routed element, else element volume. */
  setGain(element: HTMLMediaElement, gain: number): void {
    const clamped = clampGain(gain);
    const node = this.nodes.get(element);
    if (node) {
      if (node.gain.gain.value !== clamped) node.gain.gain.value = clamped;
      return;
    }
    const volume = Math.min(1, clamped);
    if (element.volume !== volume) element.volume = volume;
    const muted = volume === 0;
    if (element.muted !== muted) element.muted = muted;
  }

  /** Reset routing for a released element. */
  disconnect(element: HTMLMediaElement): void {
    const node = this.nodes.get(element);
    if (!node) return;
    this.nodes.delete(element);
    try {
      node.source.disconnect();
      node.gain.disconnect();
    } catch {
      /* already detached */
    }
  }

  /** Resume the audio context from a user gesture. */
  async resume(): Promise<void> {
    const context = this.context;
    if (!context) return;
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        /* engine's play() rejection handling covers this */
      }
    }
  }

  dispose(): void {
    for (const [element] of this.nodes) this.disconnect(element);
    this.nodes.clear();
    const context = this.context;
    this.context = null;
    if (context) {
      void context.close().catch(() => undefined);
    }
    this.unavailable = false;
  }
}

export { MAX_GAIN };
