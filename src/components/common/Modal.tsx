import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/format';
import { IconButton } from './IconButton';

interface ModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  /** prevent closing while a blocking operation is running */
  busy?: boolean;
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
  className,
  busy = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, busy]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'animate-fade-in flex max-h-[92vh] flex-col bg-[#252525] border border-[#3d3d3d] shadow-2xl',
          className,
        )}
        style={{ width }}
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#3a3a3a] px-4">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-app-text">{title}</h2>
            {subtitle ? <p className="truncate text-2xs text-app-textDim">{subtitle}</p> : null}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? (
          <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-[#3a3a3a] bg-[#222222] px-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
