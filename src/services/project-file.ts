import type { Project } from '@/types';
import { createId } from '@/utils/id';
import { normalizeProject } from './project-schema';
import { saveProjectDocument } from './storage/project-storage';

export function sanitizeFileName(name: string, extension = ''): string {
  const base = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 80);
  return `${base || 'Untitled'}${extension}`;
}

/** Download the project as a portable JSON document (media is relinked on import). */
export async function downloadProjectFile(project: Project): Promise<void> {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFileName(project.name, '.premiereweb.json');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Import a portable project document. A fresh id is generated because a
 * project with the same id may already exist locally. Media blobs are not
 * embedded, so media entries are marked offline and can be relinked.
 */
export async function importProjectFile(file: File): Promise<Project> {
  const text = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const project = normalizeProject(raw);
  project.id = createId('proj');
  project.createdAt = Date.now();
  project.updatedAt = Date.now();
  project.media = project.media.map((media) => ({ ...media, missing: true }));
  await saveProjectDocument(project);
  return project;
}
