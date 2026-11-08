import { AlertTriangle } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { Modal } from '@/components/common/Modal';

export function ConfirmDialog() {
  const request = useWorkspaceStore((s) => s.confirmRequest);
  const resolve = useWorkspaceStore((s) => s.resolveConfirm);

  return (
    <Modal
      open={Boolean(request)}
      title={request?.title ?? 'Confirm'}
      onClose={() => resolve(false)}
      width={420}
      footer={
        <>
          <button type="button" className="btn" onClick={() => resolve(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={request?.danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => resolve(true)}
          >
            {request?.confirmLabel ?? 'Continue'}
          </button>
        </>
      }
    >
      <div className="flex items-start gap-3 p-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#5d4a20] bg-[#332b17] text-[#e5b75a]">
          <AlertTriangle size={16} />
        </div>
        <p className="pt-1 text-xs leading-relaxed text-app-textDim">{request?.message}</p>
      </div>
    </Modal>
  );
}
