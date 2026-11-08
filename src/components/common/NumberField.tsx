import { useEffect, useState } from 'react';
import { cn } from '@/utils/format';

interface NumberFieldProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  disabled?: boolean;
  className?: string;
  slider?: boolean;
}

/**
 * Numeric field that keeps an editable text buffer while focused so typing
 * (e.g. decimals or intermediate "-") does not fight the controlled value.
 */
export function NumberField({
  label,
  value,
  onChange,
  min = -Number.MAX_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  precision = 0,
  unit,
  disabled,
  className,
  slider,
}: NumberFieldProps) {
  const format = (n: number) => (precision > 0 ? n.toFixed(precision) : String(Math.round(n)));
  const [text, setText] = useState(() => format(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, precision]);

  const commit = (raw: string) => {
    const parsed = Number(raw.replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setText(format(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    onChange(clamped);
    setText(format(clamped));
  };

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {label ? <label className="label">{label}</label> : null}
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            className="field-sm pr-7 text-right font-mono tabular-nums"
            value={text}
            disabled={disabled}
            onFocus={() => setFocused(true)}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => {
              setFocused(false);
              commit(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commit((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setText(format(value));
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
                const next = Math.min(max, Math.max(min, (Number(text) || 0) + delta));
                onChange(next);
                setText(format(next));
              }
            }}
          />
          {unit ? (
            <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-3xs text-app-textFaint">
              {unit}
            </span>
          ) : null}
        </div>
        {slider ? (
          <input
            type="range"
            className="w-24"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        ) : null}
      </div>
    </div>
  );
}
