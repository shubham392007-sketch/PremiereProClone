import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { cn } from '@/utils/format';

export interface ContextMenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: ContextMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Keep the menu within the viewport.
  const menuWidth = 230;
  const estimatedHeight = Math.min(420, items.length * 27 + 12);
  const left = Math.min(x, window.innerWidth - menuWidth - 8);
  const top = Math.min(y, window.innerHeight - estimatedHeight - 8);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[140] min-w-[220px] border border-[#4a4a4a] bg-[#2b2b2b] py-1 shadow-2xl"
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="separator-h" />
        ) : item.submenu ? (
          <div key={`${item.label}-${index}`} className="group relative">
            <div className={cn('menu-item justify-between', item.disabled && 'menu-item-disabled')}>
              <span className="flex items-center gap-2">
                <span className="flex h-4 w-4 items-center justify-center text-app-textDim">{item.icon}</span>
                {item.label}
              </span>
            </div>
            <div className="pointer-events-none absolute left-full top-0 hidden min-w-[180px] border border-[#4a4a4a] bg-[#2b2b2b] py-1 shadow-2xl group-hover:pointer-events-auto group-hover:block">
              {item.submenu.map((sub, subIndex) => (
                <ContextMenuEntry key={`${sub.label}-${subIndex}`} item={sub} onClose={onClose} />
              ))}
            </div>
          </div>
        ) : (
          <ContextMenuEntry key={`${item.label}-${index}`} item={item} onClose={onClose} />
        ),
      )}
    </div>,
    document.body,
  );
}

function ContextMenuEntry({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  if (item.separator) return <div className="separator-h" />;
  return (
    <button
      type="button"
      disabled={item.disabled}
      className={cn(
        'menu-item justify-between text-left',
        item.disabled && 'menu-item-disabled',
        item.danger && 'text-[#ff9b9b]',
      )}
      onClick={() => {
        if (item.disabled) return;
        onClose();
        item.onClick?.();
      }}
    >
      <span className="flex items-center gap-2">
        <span className="flex h-4 w-4 items-center justify-center text-app-textDim">
          {item.checked ? <Check size={12} /> : item.icon}
        </span>
        {item.label}
      </span>
      {item.shortcut ? <span className="ml-4 text-2xs text-app-textFaint">{item.shortcut}</span> : null}
    </button>
  );
}

export default ContextMenu;
