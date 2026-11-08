import { useEffect } from 'react';
import { startAutosave } from '@/services/autosave';
import { useProjectStore } from '@/stores/project-store';
import { ProjectHome } from '@/features/project-manager/ProjectHome';
import { EditorWorkspace } from '@/features/workspace/EditorWorkspace';
import { ToastCenter } from '@/components/notifications/ToastCenter';
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog';
import { NewProjectDialog } from '@/features/project-manager/NewProjectDialog';
import { SettingsDialog } from '@/components/dialogs/SettingsDialog';
import { ShortcutsDialog } from '@/components/dialogs/ShortcutsDialog';
import { useWorkspaceStore, notify } from '@/stores/workspace-store';
import { Spinner } from '@/components/common/EmptyState';

export default function App() {
  const project = useProjectStore((s) => s.project);
  const isOpening = useProjectStore((s) => s.isOpening);
  const confirmRequest = useWorkspaceStore((s) => s.confirmRequest);

  useEffect(() => {
    const stop = startAutosave();
    const onError = (event: ErrorEvent) => {
      if (event.error) {
        notify('error', 'Unexpected application error', event.message);
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      // Abort/cancel errors are expected during export/import cancellation.
      if (/abort|cancel/i.test(message)) return;
      notify('error', 'Operation failed unexpectedly', message);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      stop();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-app-bg text-app-text">
      {project ? <EditorWorkspace /> : <ProjectHome />}
      {isOpening ? (
        <div className="fixed inset-0 z-[180] flex flex-col items-center justify-center gap-3 bg-black/70">
          <Spinner size={22} />
          <p className="text-xs text-app-textDim">Opening project…</p>
        </div>
      ) : null}
      {confirmRequest ? <ConfirmDialog /> : null}
      <NewProjectDialog />
      <SettingsDialog />
      <ShortcutsDialog />
      <ToastCenter />
    </div>
  );
}
