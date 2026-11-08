/**
 * Export service — the app-facing facade for the export engine.
 *
 * Keeps the single in-flight export and its cancellation flag outside React,
 * resolves the active project/sequence from the stores, and re-exports the
 * settings/capability helpers used by the Export dialog.
 */
import type { ExportSettings, Project, Sequence } from '@/types';
import { getActiveSequence, useProjectStore } from '@/stores/project-store';
import { frameToSeconds, sequenceDurationFrames } from '@/utils/time';
import {
  exportSequence,
  type ExportSequenceOptions,
} from '@/engine/exporter/exporter';
import {
  createDefaultExportSettings as createDefaultSettings,
  buildExportFileName,
  estimateOutputBytes,
  normalizeExportSettings,
  outputFrameCount,
  resolveExportRange,
  sanitizeBaseName,
  suggestedVideoBitrate,
} from '@/engine/exporter/settings';
import { getExportCapabilities as detectCapabilities } from '@/engine/exporter/capabilities';
import {
  ExportValidationError,
  isExportCancelledError,
  isExportCapabilityError,
  isExportValidationError,
  type ExportCallbacks,
  type ExportCapabilities,
  type ExportRange,
  type ExportResult,
} from '@/engine/exporter/types';

export type {
  ExportCallbacks,
  ExportCapabilities,
  ExportRange,
  ExportResult,
} from '@/engine/exporter/types';
export type { AudioEncodePlan } from '@/engine/exporter/webcodecs-exporter';
export { ExportCancelledError, ExportCapabilityError, ExportError, ExportValidationError } from '@/engine/exporter/types';
export { isExportCancelledError, isExportCapabilityError, isExportValidationError };

let activeExport = false;
let cancelRequested = false;

/** True while an export is running (used by the dialog to guard closing). */
export function isExportRunning(): boolean {
  return activeExport;
}

/**
 * Request cancellation of the currently running export. The engine aborts at
 * the next frame/encode boundary and rejects with `ExportCancelledError`.
 */
export function cancelExport(): void {
  if (activeExport) cancelRequested = true;
}

/** Capability report for the dialog (cached by the engine). */
export const getExportCapabilities = detectCapabilities;

/** Default settings derived from a sequence (resolution, fps, bitrate…). */
export function createDefaultExportSettings(sequence: Sequence): ExportSettings {
  return createDefaultSettings(sequence);
}

/** Active sequence from the project store, or null. */
export function getExportSequence(): Sequence | null {
  return getActiveSequence();
}

/** Reactive-friendly helper: current project snapshot + active sequence. */
export function getExportContext(): { project: Project | null; sequence: Sequence | null } {
  const project = useProjectStore.getState().project;
  return { project, sequence: project ? getActiveSequence() : null };
}

/** Duration of the whole sequence in seconds (0 for empty sequences). */
export function getSequenceDurationSeconds(sequence: Sequence): number {
  return frameToSeconds(sequenceDurationFrames(sequence), sequence.frameRate);
}

export interface ExportEstimate {
  range: ExportRange | null;
  totalFrames: number;
  durationSeconds: number;
  estimatedBytes: number;
  error: string | null;
}

/**
 * Compute the real export range/frame count plus an approximate file size.
 * Never throws; invalid settings are reported through `error`.
 */
export function getExportEstimate(sequence: Sequence, settings: ExportSettings): ExportEstimate {
  try {
    const normalized = normalizeExportSettings(settings, sequence);
    const range = resolveExportRange(sequence, normalized);
    return {
      range,
      totalFrames: outputFrameCount(range, normalized.frameRate),
      durationSeconds: range.durationSeconds,
      estimatedBytes: estimateOutputBytes(normalized, range),
      error: null,
    };
  } catch (error) {
    return {
      range: null,
      totalFrames: 0,
      durationSeconds: 0,
      estimatedBytes: 0,
      error: error instanceof Error ? error.message : 'Export settings are invalid.',
    };
  }
}

/**
 * Export the active sequence of the open project.
 *
 * This is the method the Export dialog calls: it snapshots the current project
 * from the store, wires cancellation, and delegates to the engine.
 */
export async function exportActiveSequence(
  settings: ExportSettings,
  callbacks: ExportCallbacks = {},
): Promise<ExportResult> {
  if (activeExport) {
    throw new ExportValidationError('An export is already in progress. Wait for it to finish or cancel it.');
  }
  const project = useProjectStore.getState().project;
  if (!project) {
    throw new ExportValidationError('Open a project before exporting.');
  }
  const sequence = getActiveSequence();
  if (!sequence) {
    throw new ExportValidationError('There is no active sequence to export.');
  }

  activeExport = true;
  cancelRequested = false;
  try {
    return await exportSequence(project, sequence, settings, {
      ...callbacks,
      shouldCancel: () => cancelRequested || Boolean(callbacks.shouldCancel?.()),
    });
  } finally {
    activeExport = false;
    cancelRequested = false;
  }
}

/** Build a filename for the chosen container (used by the dialog preview). */
export { buildExportFileName, estimateOutputBytes, outputFrameCount, resolveExportRange, sanitizeBaseName, suggestedVideoBitrate };

/** Re-export the engine entry point for advanced callers with explicit project/sequence. */
export { exportSequence };
export type { ExportSequenceOptions };
