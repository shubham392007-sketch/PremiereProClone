import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { cn } from '@/utils/format';

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

const COLORS = {
  info: 'text-[#6fa8ff] border-[#2f4f77]',
  success: 'text-[#63c995] border-[#2f5f49]',
  warning: 'text-[#e5b75a] border-[#6b5324]',
  error: 'text-[#ff8b8b] border-[#6b2b2b]',
} as const;

export function ToastCenter() {
  const notifications = useWorkspaceStore((s) => s.notifications);
  const dismiss = useWorkspaceStore((s) => s.dismissNotification);

  if (!notifications.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[200] flex w-[340px] flex-col gap-2">
      {notifications.map((item) => {
        const Icon = ICONS[item.kind];
        return (
          <div
            key={item.id}
            className={cn(
              'animate-fade-in pointer-events-auto flex items-start gap-2 border bg-[#252525] px-3 py-2 shadow-xl',
              COLORS[item.kind],
            )}
          >
            <Icon size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-app-text">{item.message}</p>
              {item.detail ? <p className="mt-0.5 break-words text-2xs leading-snug text-app-textDim">{item.detail}</p> : null}
            </div>
            <button
              type="button"
              className="icon-btn h-5 min-w-5 shrink-0"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
