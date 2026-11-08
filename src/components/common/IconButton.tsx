import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/format';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: number;
  iconSize?: number;
}

/** Compact toolbar button with accessible label and native tooltip. */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  active,
  size = 24,
  iconSize = 14,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      data-active={active ? 'true' : undefined}
      className={cn('icon-btn', active && 'icon-btn-active', className)}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon size={iconSize} strokeWidth={1.75} />
    </button>
  );
}
