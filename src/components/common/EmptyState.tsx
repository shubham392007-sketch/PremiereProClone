import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/utils/format';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-2 px-6 text-center', className)}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#3a3a3a] bg-[#262626] text-app-textDesc">
        <Icon size={18} strokeWidth={1.5} />
      </div>
      <p className="text-xs font-medium text-app-textDim">{title}</p>
      {description ? <p className="max-w-[280px] text-2xs leading-relaxed text-app-textFaint">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-block animate-spin-slow rounded-full border-2 border-app-textFaint border-t-transparent', className)}
      style={{ width: size, height: size }}
      aria-label="Loading"
      role="status"
    />
  );
}
