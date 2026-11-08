import type { ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/utils/format';

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  hint?: string;
  containerClassName?: string;
}

export function SelectField({
  label,
  value,
  onValueChange,
  options,
  hint,
  containerClassName,
  className,
  ...rest
}: SelectFieldProps) {
  return (
    <div className={cn('flex flex-col gap-0.5', containerClassName)}>
      {label ? <label className="label">{label}</label> : null}
      <select
        className={cn('select', className)}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        {...rest}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {hint ? <span className="text-3xs text-app-textFaint">{hint}</span> : null}
    </div>
  );
}

export function FieldGroup({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="text-3xs text-app-textFaint">{hint}</span> : null}
    </div>
  );
}
