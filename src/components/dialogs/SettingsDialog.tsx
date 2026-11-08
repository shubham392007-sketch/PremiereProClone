import { useEffect, useState } from 'react';
import { AlertTriangle, Database, HardDrive, Keyboard, RefreshCw, Trash2, Zap } from 'lucide-react';
import type { BrowserCapabilities } from '@/utils/browser';
import { detectCapabilities } from '@/utils/browser';
import { mediaStorage } from '@/services/storage/media-storage';
import { cleanupOrphanMedia, clearAllLocalData, listProjectSummaries } from '@/services/storage/project-storage';
import { useProjectStore } from '@/stores/project-store';
import { useWorkspaceStore, confirmAction, notify } from '@/stores/workspace-store';
import { Modal } from '@/components/common/Modal';
import { formatBytes } from '@/utils/format';

export function SettingsDialog() {
  const open = useWorkspaceStore((s) => s.dialogs.settings);
  const closeDialog = useWorkspaceStore((s) => s.closeDialog);
  const openDialog = useWorkspaceStore((s) => s.openDialog);
  const closeProject = useProjectStore((s) => s.closeProject);

  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);
  const [backend, setBackend] = useState<'opfs' | 'indexeddb' | null>(null);
  const [projectCount, setProjectCount] = useState(0);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [capabilities, storageBackend, summaries] = await Promise.all([
      detectCapabilities(),
      mediaStorage.backend(),
      listProjectSummaries().catch(() => []),
    ]);
    setCaps(capabilities);
    setBackend(storageBackend);
    setProjectCount(summaries.length);
    setUsage(capabilities.storageEstimate);
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  const handleCleanup = async () => {
    setBusy(true);
    try {
      const removed = await cleanupOrphanMedia();
      notify('success', 'Orphaned media cleaned', removed ? `${removed} unused media blob${removed === 1 ? '' : 's'} removed.` : 'No orphaned media was found.');
      await refresh();
    } catch (error) {
      notify('error', 'Cleanup failed', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const handleResetLayout = () => {
    try {
      localStorage.removeItem('premiere-web-layout');
      useWorkspaceStore.getState().setLeftWidthPct(22);
      useWorkspaceStore.getState().setTimelineHeightPct(40);
      useWorkspaceStore.getState().setPropertiesVisible(true);
      notify('success', 'Workspace layout reset');
    } catch {
      notify('error', 'Could not reset layout');
    }
  };

  const handleDeleteAll = () => {
    confirmAction({
      title: 'Delete all local data',
      message:
        'This permanently deletes every project and all stored media in this browser. Export anything you need first. This cannot be undone.',
      confirmLabel: 'Delete Everything',
      danger: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          closeProject();
          await clearAllLocalData();
          closeDialog('settings');
          notify('success', 'All local editor data deleted');
        } catch (error) {
          notify('error', 'Could not delete local data', error instanceof Error ? error.message : undefined);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const usagePct = usage && usage.quota > 0 ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;

  return (
    <Modal
      open={open}
      title="Settings"
      subtitle="Storage, browser capabilities and maintenance"
      onClose={() => closeDialog('settings')}
      width={620}
      footer={
        <button type="button" className="btn" onClick={() => closeDialog('settings')}>
          Close
        </button>
      }
    >
      <div className="space-y-4 p-4">
        <section className="border border-app-border bg-[#1d1d1d] p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-app-textDim">
            <Database size={12} /> Local storage
          </h3>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <p className="text-3xs uppercase text-app-textFaint">Projects</p>
              <p className="mt-0.5 text-app-text">{projectCount}</p>
            </div>
            <div>
              <p className="text-3xs uppercase text-app-textFaint">Media backend</p>
              <p className="mt-0.5 text-app-text">{backend === 'opfs' ? 'OPFS + IndexedDB' : backend === 'indexeddb' ? 'IndexedDB' : '—'}</p>
            </div>
            <div>
              <p className="text-3xs uppercase text-app-textFaint">Browser usage</p>
              <p className="mt-0.5 text-app-text">{usage ? `${formatBytes(usage.usage)} / ${formatBytes(usage.quota)}` : '—'}</p>
            </div>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden bg-[#333333]">
            <div className="h-full bg-app-accent" style={{ width: `${usagePct}%` }} />
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-app-textFaint">
            Projects and media are stored only in this browser profile. Clearing browser site data removes them.
          </p>
        </section>

        <section className="border border-app-border bg-[#1d1d1d] p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-app-textDim">
            <Zap size={12} /> Browser capabilities
          </h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-2xs">
            <Capability label="WebCodecs video encode" value={caps?.webCodecs} />
            <Capability label="H.264 encoder" value={caps?.canEncodeH264} />
            <Capability label="AAC audio encoder" value={caps?.canEncodeAac} />
            <Capability label="OPFS file storage" value={caps?.opfs} />
            <Capability label="MediaRecorder fallback" value={caps?.mediaRecorder} />
            <Capability label="H.264 source decode" value={caps ? true : null} hint="Depends on browser codec licensing" />
          </div>
        </section>

        <section className="space-y-2 border border-app-border bg-[#1d1d1d] p-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-app-textDim">
            <HardDrive size={12} /> Maintenance
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" onClick={() => void handleCleanup()} disabled={busy}>
              <RefreshCw size={12} /> Clean orphaned media
            </button>
            <button type="button" className="btn" onClick={handleResetLayout} disabled={busy}>
              Reset panel layout
            </button>
            <button type="button" className="btn" onClick={() => openDialog('shortcuts')}>
              <Keyboard size={12} /> Keyboard shortcuts
            </button>
          </div>
          <button
            type="button"
            className="btn-danger mt-1"
            onClick={handleDeleteAll}
            disabled={busy}
          >
            <Trash2 size={12} /> Delete all local editor data
          </button>
          <p className="flex items-start gap-1 text-2xs text-app-textFaint">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            Only use this if you want to wipe every project stored in this browser.
          </p>
        </section>

        <p className="text-center text-3xs text-app-textFaint">
          Premiere Web · Phase 1 · Schema v1 · Interface inspired by Adobe Premiere Pro (not affiliated)
        </p>
      </div>
    </Modal>
  );
}

function Capability({ label, value, hint }: { label: string; value: boolean | null | undefined; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2" title={hint}>
      <span className="text-app-textDim">{label}</span>
      <span className={value === null || value === undefined ? 'text-app-textFaint' : value ? 'text-app-success' : 'text-[#e5b75a]'}>
        {value === null || value === undefined ? 'unknown' : value ? 'available' : 'unavailable'}
      </span>
    </div>
  );
}
