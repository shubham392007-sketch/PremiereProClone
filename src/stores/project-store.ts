import { create } from 'zustand';
import type { Bin, MediaAsset, NewProjectConfig, Project, SaveStatus, Sequence, WorkspaceState } from '@/types';
import { createId } from '@/utils/id';
import { createProject, findSequence } from '@/engine/timeline/factory';
import { normalizeProject } from '@/services/project-schema';
import {
  cleanupOrphanMedia,
  loadProjectDocument,
  saveProjectDocument,
  setAppMeta,
} from '@/services/storage/project-storage';
import { useMediaStore } from './media-store';
import { usePlaybackStore } from './playback-store';
import { notify } from './workspace-store';

const MAX_HISTORY = 120;

interface HistoryEntry {
  snapshot: Project;
  label: string;
}

export interface EditOptions {
  history?: boolean;
  /** bump updatedAt (default true) */
  touch?: boolean;
}

interface ProjectState {
  project: Project | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: number | null;
  isOpening: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];
  undoLabel: string | null;
  redoLabel: string | null;

  createNewProject: (config: NewProjectConfig) => Promise<Project>;
  openProject: (id: string) => Promise<Project>;
  closeProject: () => void;
  saveNow: () => Promise<boolean>;
  applyEdit: (label: string, mutator: (draft: Project) => void, opts?: EditOptions) => void;
  /** clone of the current project for live-drag transactions (null if no project) */
  snapshotProject: () => Project | null;
  commitSnapshot: (before: Project, label: string) => void;
  updateWorkspace: (patch: Partial<WorkspaceState>) => void;
  undo: () => void;
  redo: () => void;

  renameProject: (name: string) => void;
  addMedia: (assets: MediaAsset[]) => void;
  updateMedia: (mediaId: string, patch: Partial<MediaAsset>, label?: string) => void;
  removeMedia: (mediaId: string) => void;
  addBin: (name: string, parentId?: string | null) => Bin;
  renameBin: (binId: string, name: string) => void;
  deleteBin: (binId: string) => void;
  moveMediaToBin: (mediaId: string, binId: string | null) => void;
  updateSequence: (mutator: (sequence: Sequence) => void, label: string, opts?: EditOptions) => void;
}

let saveInFlight: Promise<boolean> | null = null;

function resetPlayback(): void {
  const playback = usePlaybackStore.getState();
  playback.setCurrentFrame(0);
  playback.setIsPlaying(false);
  playback.closeSource();
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  saveStatus: 'idle',
  saveError: null,
  lastSavedAt: null,
  isOpening: false,
  past: [],
  future: [],
  undoLabel: null,
  redoLabel: null,

  async createNewProject(config) {
    useMediaStore.getState().clearAllUrls();
    resetPlayback();
    const project = createProject(config);
    await saveProjectDocument(project);
    set({
      project,
      saveStatus: 'saved',
      saveError: null,
      lastSavedAt: Date.now(),
      past: [],
      future: [],
      undoLabel: null,
      redoLabel: null,
      isOpening: false,
    });
    await setAppMeta('lastProjectId', project.id).catch(() => undefined);
    return project;
  },

  async openProject(id) {
    set({ isOpening: true, saveError: null });
    try {
      const loaded = await loadProjectDocument(id);
      const missing = await useMediaStore.getState().hydrateProjectMedia(loaded.media);
      // Reconcile the persisted offline flags with what actually rehydrated.
      loaded.media = loaded.media.map((media) =>
        missing.includes(media.id) ? { ...media, missing: true } : { ...media, missing: false },
      );
      resetPlayback();
      set({
        project: loaded,
        saveStatus: 'saved',
        saveError: null,
        lastSavedAt: loaded.updatedAt,
        isOpening: false,
        past: [],
        future: [],
        undoLabel: null,
        redoLabel: null,
      });
      await setAppMeta('lastProjectId', loaded.id).catch(() => undefined);
      if (missing.length) {
        notify(
          'warning',
          `${missing.length} media file${missing.length === 1 ? '' : 's'} could not be found`,
          'The project opened, but clips referencing missing media will show as offline. Re-import the file to restore it.',
        );
      }
      return loaded;
    } catch (error) {
      set({ isOpening: false, saveError: error instanceof Error ? error.message : 'Unable to open project' });
      throw error;
    }
  },

  closeProject() {
    useMediaStore.getState().clearAllUrls();
    resetPlayback();
    set({
      project: null,
      saveStatus: 'idle',
      saveError: null,
      lastSavedAt: null,
      past: [],
      future: [],
      undoLabel: null,
      redoLabel: null,
    });
  },

  async saveNow() {
    if (saveInFlight) return saveInFlight;
    const project = get().project;
    if (!project) return false;
    set({ saveStatus: 'saving', saveError: null });
    const snapshot = project;
    saveInFlight = (async () => {
      try {
        await saveProjectDocument(snapshot);
        const stillCurrent = get().project === snapshot;
        set({
          saveStatus: stillCurrent ? 'saved' : 'unsaved',
          lastSavedAt: Date.now(),
          saveError: null,
        });
        await setAppMeta('lastProjectId', snapshot.id).catch(() => undefined);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown storage error';
        set({ saveStatus: 'error', saveError: message });
        notify('error', 'Project could not be saved', message);
        return false;
      } finally {
        saveInFlight = null;
      }
    })();
    return saveInFlight;
  },

  applyEdit(label, mutator, opts) {
    const current = get().project;
    if (!current) return;
    const draft = structuredClone(current);
    mutator(draft);
    // Compare content before touching the timestamp: otherwise every no-op edit
    // (e.g. Enter + blur committing the same value) would create a history step.
    draft.updatedAt = current.updatedAt;
    const changed = JSON.stringify(draft) !== JSON.stringify(current);
    if (!changed) return;
    if (opts?.touch !== false) draft.updatedAt = Date.now();
    const recordHistory = opts?.history !== false;
    if (recordHistory) {
      set((state) => ({
        project: draft,
        past: [...state.past, { snapshot: current, label }].slice(-MAX_HISTORY),
        future: [],
        undoLabel: label,
        redoLabel: null,
        saveStatus: 'unsaved',
        saveError: null,
      }));
    } else {
      set({ project: draft, saveStatus: 'unsaved', saveError: null });
    }
  },

  snapshotProject() {
    const project = get().project;
    return project ? structuredClone(project) : null;
  },

  commitSnapshot(before, label) {
    const current = get().project;
    if (!current || !before) return;
    if (JSON.stringify(before) === JSON.stringify(current)) return;
    set((state) => ({
      past: [...state.past, { snapshot: before, label }].slice(-MAX_HISTORY),
      future: [],
      undoLabel: label,
      redoLabel: null,
      saveStatus: 'unsaved',
    }));
  },

  updateWorkspace(patch) {
    get().applyEdit('Update workspace', (draft) => {
      draft.workspace = { ...draft.workspace, ...patch };
    }, { history: false });
  },

  undo() {
    const { past, project, future } = get();
    if (!past.length || !project) return;
    const entry = past[past.length - 1];
    const remaining = past.slice(0, -1);
    set({
      project: entry.snapshot,
      past: remaining,
      future: [...future, { snapshot: project, label: entry.label }].slice(-MAX_HISTORY),
      undoLabel: remaining.length ? remaining[remaining.length - 1].label : null,
      redoLabel: entry.label,
      saveStatus: 'unsaved',
      saveError: null,
    });
  },

  redo() {
    const { future, project, past } = get();
    if (!future.length || !project) return;
    const entry = future[future.length - 1];
    const remaining = future.slice(0, -1);
    set({
      project: entry.snapshot,
      past: [...past, { snapshot: project, label: entry.label }].slice(-MAX_HISTORY),
      future: remaining,
      undoLabel: entry.label,
      redoLabel: remaining.length ? remaining[remaining.length - 1].label : null,
      saveStatus: 'unsaved',
      saveError: null,
    });
  },

  renameProject(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().applyEdit('Rename project', (draft) => {
      draft.name = trimmed;
    });
  },

  addMedia(assets) {
    if (!assets.length) return;
    get().applyEdit(`Import ${assets.length} media file${assets.length === 1 ? '' : 's'}`, (draft) => {
      draft.media.push(...assets);
    });
  },

  updateMedia(mediaId, patch, label = 'Update media') {
    get().applyEdit(label, (draft) => {
      const media = draft.media.find((m) => m.id === mediaId);
      if (media) Object.assign(media, patch);
    });
  },

  removeMedia(mediaId) {
    const project = get().project;
    if (!project) return;
    get().applyEdit('Remove media', (draft) => {
      draft.media = draft.media.filter((m) => m.id !== mediaId);
      for (const sequence of draft.sequences) {
        sequence.clips = sequence.clips.filter((clip) => clip.mediaId !== mediaId);
      }
    });
    useMediaStore.getState().removeMediaUrl(mediaId);
    // Persist, then remove the orphaned blob(s) if no other project references them.
    void (async () => {
      await get().saveNow();
      await cleanupOrphanMedia().catch(() => undefined);
    })();
  },

  addBin(name, parentId = null) {
    const bin: Bin = { id: createId('bin'), name: name.trim() || 'New Bin', parentId, createdAt: Date.now() };
    get().applyEdit('Create bin', (draft) => {
      draft.bins.push(bin);
    });
    return bin;
  },

  renameBin(binId, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().applyEdit('Rename bin', (draft) => {
      const bin = draft.bins.find((b) => b.id === binId);
      if (bin) bin.name = trimmed;
    });
  },

  deleteBin(binId) {
    get().applyEdit('Delete bin', (draft) => {
      draft.bins = draft.bins.filter((b) => b.id !== binId);
      for (const bin of draft.bins) if (bin.parentId === binId) bin.parentId = null;
      for (const media of draft.media) if (media.binId === binId) media.binId = null;
    });
  },

  moveMediaToBin(mediaId, binId) {
    get().applyEdit('Move media to bin', (draft) => {
      const media = draft.media.find((m) => m.id === mediaId);
      if (media) media.binId = binId;
    });
  },

  updateSequence(mutator, label, opts) {
    get().applyEdit(label, (draft) => {
      const sequence = findSequence(draft);
      if (sequence) mutator(sequence);
    }, opts);
  },
}));

/** Active sequence selector helper usable outside components. */
export function getActiveSequence(): Sequence | null {
  const project = useProjectStore.getState().project;
  if (!project) return null;
  return findSequence(project) ?? project.sequences[0] ?? null;
}
