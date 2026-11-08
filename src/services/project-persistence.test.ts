import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaAsset, NewProjectConfig, Project } from '@/types';
import { createProject, makeClip, makeFrameRate } from '@/engine/timeline/factory';
import { duplicateProjectDocument, normalizeProject, projectSummary } from '@/services/project-schema';
import {
  clearAllLocalData,
  deleteProjectDocument,
  duplicateProjectRecord,
  listProjectSummaries,
  loadProjectDocument,
  saveProjectDocument,
} from '@/services/storage/project-storage';
import { MEDIA_COLORS } from '@/utils/presets';
import { getVideoTracks } from '@/engine/timeline/operations';

const CONFIG: NewProjectConfig = {
  name: 'Persistence Test',
  sequenceName: 'Main',
  width: 1920,
  height: 1080,
  frameRate: makeFrameRate(30),
  audioSampleRate: 48000,
  colorSpace: 'Rec.709',
  previewQuality: 'full',
};

function makeAsset(): MediaAsset {
  return {
    id: 'media_persist_1',
    name: 'clip.mp4',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    kind: 'video',
    sizeBytes: 1024,
    durationSec: 10,
    width: 1920,
    height: 1080,
    fps: makeFrameRate(30),
    hasAudio: true,
    thumbnailDataUrl: 'data:image/jpeg;base64,AAAA',
    storageKey: 'idb:media_persist_1.mp4',
    importedAt: Date.now(),
    binId: null,
  };
}

function makeProjectWithClip(): Project {
  const project = createProject(CONFIG);
  const asset = makeAsset();
  project.media.push(asset);
  const sequence = project.sequences[0];
  const track = getVideoTracks(sequence)[0];
  sequence.clips.push(
    makeClip({
      mediaId: asset.id,
      trackId: track.id,
      startFrame: 45,
      durationFrames: 120,
      sourceInFrame: 15,
      color: MEDIA_COLORS.video,
      name: 'My Clip',
    }),
  );
  return project;
}

describe('project document duplication', () => {
  it('deep-copies editing state with fresh ids and remapped references', () => {
    const project = makeProjectWithClip();
    const originalClip = project.sequences[0].clips[0];
    const duplicate = duplicateProjectDocument(project);

    expect(duplicate.id).not.toBe(project.id);
    expect(duplicate.name).toContain('copy');
    expect(duplicate.sequences[0].id).not.toBe(project.sequences[0].id);
    expect(duplicate.media[0].id).not.toBe(project.media[0].id);
    expect(duplicate.media[0].storageKey).toBe(project.media[0].storageKey);
    const copyClip = duplicate.sequences[0].clips[0];
    expect(copyClip.id).not.toBe(originalClip.id);
    expect(copyClip.mediaId).toBe(duplicate.media[0].id);
    expect(copyClip.trackId).toBe(duplicate.sequences[0].tracks[0].id);
    expect(copyClip.startFrame).toBe(originalClip.startFrame);
    expect(copyClip.sourceInFrame).toBe(originalClip.sourceInFrame);
    expect(copyClip.durationFrames).toBe(originalClip.durationFrames);
    // timeline frames remain integers
    expect(Number.isInteger(copyClip.startFrame)).toBe(true);
    expect(Number.isInteger(copyClip.durationFrames)).toBe(true);
  });
});

describe('project document normalisation', () => {
  it('rejects project data from a newer schema version', () => {
    const project = makeProjectWithClip();
    expect(() => normalizeProject({ ...project, schemaVersion: 99 })).toThrow(/newer version/i);
  });

  it('rejects documents without sequences', () => {
    expect(() => normalizeProject({ schemaVersion: 1, sequences: [] })).toThrow(/no sequences/i);
  });

  it('repairs missing fields and drops clips with missing media or tracks', () => {
    const project = makeProjectWithClip();
    const raw = structuredClone(project) as unknown as Record<string, unknown>;
    const sequences = raw.sequences as Record<string, unknown>[];
    const clips = sequences[0].clips as Record<string, unknown>[];
    clips.push({
      id: 'bad-track',
      mediaId: project.media[0].id,
      trackId: 'does-not-exist',
      startFrame: 0,
      durationFrames: 10,
    });
    clips.push({
      id: 'bad-media',
      mediaId: 'missing-media',
      trackId: project.sequences[0].tracks[0].id,
      startFrame: 0,
      durationFrames: 10,
    });
    delete raw.workspace;
    sequences[0].frameRate = undefined;

    const normalized = normalizeProject(raw);
    expect(normalized.sequences[0].clips).toHaveLength(1);
    expect(normalized.sequences[0].frameRate.num).toBe(30);
    expect(normalized.workspace.timelinePixelsPerSecond).toBeGreaterThan(0);
    expect(normalized.schemaVersion).toBe(1);
  });

  it('summarises active sequence resolution and frame rate', () => {
    const project = makeProjectWithClip();
    const summary = projectSummary(project);
    expect(summary.width).toBe(1920);
    expect(summary.height).toBe(1080);
    expect(summary.frameRate.num).toBe(30);
    expect(summary.mediaCount).toBe(1);
    expect(summary.thumbnailDataUrl).toContain('data:image');
  });
});

describe('project persistence (IndexedDB)', () => {
  beforeEach(async () => {
    await clearAllLocalData();
  });

  it('saves and restores a project with its editing state intact', async () => {
    const project = makeProjectWithClip();
    project.sequences[0].clips[0].durationFrames = 77;
    project.workspace.timelinePixelsPerSecond = 123;
    await saveProjectDocument(project);

    const loaded = await loadProjectDocument(project.id);
    expect(loaded.id).toBe(project.id);
    expect(loaded.name).toBe(project.name);
    expect(loaded.media).toHaveLength(1);
    expect(loaded.media[0].storageKey).toBe('idb:media_persist_1.mp4');
    expect(loaded.sequences[0].clips).toHaveLength(1);
    expect(loaded.sequences[0].clips[0].durationFrames).toBe(77);
    expect(loaded.sequences[0].clips[0].startFrame).toBe(45);
    expect(loaded.workspace.timelinePixelsPerSecond).toBe(123);

    const summaries = await listProjectSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(project.id);
  });

  it('duplicates and deletes stored projects', async () => {
    const project = makeProjectWithClip();
    await saveProjectDocument(project);

    const duplicate = await duplicateProjectRecord(project.id);
    expect(duplicate).not.toBeNull();
    expect(duplicate!.id).not.toBe(project.id);
    expect(await listProjectSummaries()).toHaveLength(2);

    await deleteProjectDocument(project.id);
    const remaining = await listProjectSummaries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(duplicate!.id);

    await loadProjectDocument('missing-project').catch((error: Error) => {
      expect(error.message).toMatch(/not found/i);
    });
  });

  it('persists multiple projects and keeps the most recently updated first', async () => {
    const first = makeProjectWithClip();
    first.updatedAt = 1000;
    await saveProjectDocument(first);

    const second = makeProjectWithClip();
    second.id = 'project_second';
    second.name = 'Second Project';
    second.updatedAt = 5000;
    await saveProjectDocument(second);

    const summaries = await listProjectSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].id).toBe('project_second');
  });
});
