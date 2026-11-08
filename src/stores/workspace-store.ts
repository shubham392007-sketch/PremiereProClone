import { create } from 'zustand';
import type { NotificationItem } from '@/types';
import { createId } from '@/utils/id';

export type DialogName = 'new-project' | 'export' | 'settings' | 'shortcuts' | 'about' | 'relink';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface WorkspaceUIState {
  dialogs: Record<DialogName, boolean>;
  notifications: NotificationItem[];
  confirmRequest: ConfirmRequest | null;
  leftWidthPct: number;
  timelineHeightPct: number;
  propertiesVisible: boolean;
  /** modal used by the project manager screen */
  projectHomeBusy: boolean;

  openDialog: (name: DialogName) => void;
  closeDialog: (name: DialogName) => void;
  notify: (kind: NotificationItem['kind'], message: string, detail?: string, durationMs?: number) => string;
  dismissNotification: (id: string) => void;
  requestConfirm: (request: ConfirmRequest) => void;
  resolveConfirm: (confirmed: boolean) => void;
  setLeftWidthPct: (pct: number) => void;
  setTimelineHeightPct: (pct: number) => void;
  setPropertiesVisible: (visible: boolean) => void;
  setProjectHomeBusy: (busy: boolean) => void;
}

const savedLayout = (() => {
  try {
    const raw = localStorage.getItem('premiere-web-layout');
    if (!raw) return null;
    return JSON.parse(raw) as { leftWidthPct?: number; timelineHeightPct?: number; propertiesVisible?: boolean };
  } catch {
    return null;
  }
})();

function persistLayout(leftWidthPct: number, timelineHeightPct: number, propertiesVisible: boolean) {
  try {
    localStorage.setItem('premiere-web-layout', JSON.stringify({ leftWidthPct, timelineHeightPct, propertiesVisible }));
  } catch {
    /* storage may be unavailable in private mode */
  }
}

const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useWorkspaceStore = create<WorkspaceUIState>((set, get) => ({
  dialogs: {
    'new-project': false,
    export: false,
    settings: false,
    shortcuts: false,
    about: false,
    relink: false,
  },
  notifications: [],
  confirmRequest: null,
  leftWidthPct: Math.min(40, Math.max(14, savedLayout?.leftWidthPct ?? 22)),
  timelineHeightPct: Math.min(72, Math.max(22, savedLayout?.timelineHeightPct ?? 40)),
  propertiesVisible: savedLayout?.propertiesVisible ?? true,
  projectHomeBusy: false,

  openDialog: (name) => set((state) => ({ dialogs: { ...state.dialogs, [name]: true } })),
  closeDialog: (name) => set((state) => ({ dialogs: { ...state.dialogs, [name]: false } })),

  notify: (kind, message, detail, durationMs = 5000) => {
    const id = createId('toast');
    const item: NotificationItem = { id, kind, message, detail, createdAt: Date.now() };
    set((state) => ({ notifications: [...state.notifications, item].slice(-6) }));
    if (durationMs > 0 && kind !== 'error') {
      const timer = setTimeout(() => {
        get().dismissNotification(id);
      }, durationMs);
      autoDismissTimers.set(id, timer);
    }
    return id;
  },
  dismissNotification: (id) => {
    const timer = autoDismissTimers.get(id);
    if (timer) clearTimeout(timer);
    autoDismissTimers.delete(id);
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
  },
  requestConfirm: (confirmRequest) => set({ confirmRequest }),
  resolveConfirm: (confirmed) => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    if (confirmed && request) void request.onConfirm();
  },
  setLeftWidthPct: (leftWidthPct) => {
    const clamped = Math.min(40, Math.max(14, leftWidthPct));
    set({ leftWidthPct: clamped });
    persistLayout(clamped, get().timelineHeightPct, get().propertiesVisible);
  },
  setTimelineHeightPct: (timelineHeightPct) => {
    const clamped = Math.min(72, Math.max(22, timelineHeightPct));
    set({ timelineHeightPct: clamped });
    persistLayout(get().leftWidthPct, clamped, get().propertiesVisible);
  },
  setPropertiesVisible: (propertiesVisible) => {
    set({ propertiesVisible });
    persistLayout(get().leftWidthPct, get().timelineHeightPct, propertiesVisible);
  },
  setProjectHomeBusy: (projectHomeBusy) => set({ projectHomeBusy }),
}));

/** Convenience helper usable outside React components. */
export function notify(
  kind: NotificationItem['kind'],
  message: string,
  detail?: string,
  durationMs?: number,
): string {
  return useWorkspaceStore.getState().notify(kind, message, detail, durationMs);
}

export function confirmAction(request: ConfirmRequest): void {
  useWorkspaceStore.getState().requestConfirm(request);
}
