import { useProjectStore } from '@/stores/project-store';

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
const AUTOSAVE_DEBOUNCE_MS = 1500;

function scheduleSave(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const { project, saveStatus, isOpening } = useProjectStore.getState();
    if (!project || isOpening) return;
    if (saveStatus === 'unsaved') void useProjectStore.getState().saveNow();
  }, AUTOSAVE_DEBOUNCE_MS);
}

function flush(): void {
  const { project, saveStatus, isOpening } = useProjectStore.getState();
  if (!project || isOpening) return;
  if (saveStatus === 'unsaved') void useProjectStore.getState().saveNow();
}

/**
 * Debounced autosave. Saves at most once per idle period (never per pointer
 * move), on tab hide and periodically while there are unsaved changes.
 */
export function startAutosave(): () => void {
  if (started) return () => undefined;
  started = true;

  unsubscribe = useProjectStore.subscribe((state, prev) => {
    if (state.project && state.project !== prev.project && state.saveStatus === 'unsaved') {
      scheduleSave();
    }
  });

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onBeforeUnload = () => {
    flush();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', onBeforeUnload);
  interval = setInterval(() => {
    const { saveStatus } = useProjectStore.getState();
    if (saveStatus === 'unsaved') flush();
  }, 30_000);

  return () => {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('beforeunload', onBeforeUnload);
    unsubscribe?.();
    started = false;
  };
}

/** Manual flush used before closing a project or navigating away. */
export async function flushAutosave(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const { project, saveStatus } = useProjectStore.getState();
  if (project && saveStatus === 'unsaved') {
    await useProjectStore.getState().saveNow();
  }
}
