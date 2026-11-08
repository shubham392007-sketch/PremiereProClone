import type { Project, ProjectSummary } from '@/types';
import { duplicateProjectDocument, normalizeProject, projectSummary } from '@/services/project-schema';
import { idbClear, idbDelete, idbGet, idbGetAll, idbPut } from './idb';
import { mediaStorage } from './media-storage';

const PROJECTS_STORE = 'projects';

export async function saveProjectDocument(project: Project): Promise<void> {
  // Persist a defensive clone so subsequent in-memory edits cannot mutate the
  // record that IndexedDB is writing.
  const document = structuredClone(project);
  await idbPut(PROJECTS_STORE, document);
}

export async function loadProjectDocument(id: string): Promise<Project> {
  const raw = await idbGet<Project>(PROJECTS_STORE, id);
  if (!raw) throw new Error('Project not found in local storage.');
  return normalizeProject(raw);
}

export async function listProjectDocuments(): Promise<Project[]> {
  const docs = await idbGetAll<Project>(PROJECTS_STORE);
  const projects: Project[] = [];
  for (const raw of docs) {
    try {
      projects.push(normalizeProject(raw));
    } catch (error) {
      console.warn('Skipping unreadable project record', (raw as { id?: string })?.id, error);
    }
  }
  return projects;
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  const projects = await listProjectDocuments();
  return projects
    .map((project) => projectSummary(project))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Deletes the project record and any media blobs that are no longer referenced
 * by another project. Media shared by duplicated projects is preserved.
 */
export async function deleteProjectDocument(id: string): Promise<void> {
  const all = await idbGetAll<Project>(PROJECTS_STORE);
  const target = all.find((p) => p.id === id);
  await idbDelete(PROJECTS_STORE, id);
  if (!target) return;
  const stillUsed = new Set<string>();
  for (const other of all) {
    if (!other || other.id === id) continue;
    for (const media of other.media ?? []) {
      if (media.storageKey) stillUsed.add(media.storageKey);
    }
  }
  for (const media of target.media ?? []) {
    if (media.storageKey && !stillUsed.has(media.storageKey)) {
      await mediaStorage.deleteFile(media.storageKey).catch(() => undefined);
    }
  }
}

export async function duplicateProjectRecord(id: string): Promise<Project | null> {
  const source = await idbGet<Project>(PROJECTS_STORE, id);
  if (!source) return null;
  const duplicate = duplicateProjectDocument(normalizeProject(source));
  await saveProjectDocument(duplicate);
  return duplicate;
}

/** Remove media blobs that are not referenced by any stored project. */
export async function cleanupOrphanMedia(): Promise<number> {
  const projects = await idbGetAll<Project>(PROJECTS_STORE);
  const referenced = new Set<string>();
  for (const project of projects) {
    for (const media of project.media ?? []) {
      if (media.storageKey) referenced.add(media.storageKey);
    }
  }
  const records = await idbGetAll<{ key: string }>('media');
  let removed = 0;
  for (const record of records) {
    if (!referenced.has(record.key)) {
      await mediaStorage.deleteFile(record.key).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

export async function setAppMeta(key: string, value: unknown): Promise<void> {
  await idbPut('app', { key, value, updatedAt: Date.now() });
}

export async function getAppMeta<T>(key: string): Promise<T | undefined> {
  const record = await idbGet<{ key: string; value: T }>('app', key);
  return record?.value;
}

/** Wipe all projects, app metadata and stored media. Used by Settings. */
export async function clearAllLocalData(): Promise<void> {
  await idbClear('projects');
  await idbClear('app');
  await mediaStorage.clearAll();
}
