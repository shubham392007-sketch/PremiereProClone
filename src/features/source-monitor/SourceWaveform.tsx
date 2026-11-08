/** Large audio waveform shown in the source monitor for audio-only media. */
import { useEffect, useRef } from 'react';
import { AudioLines } from 'lucide-react';
import { drawWaveform } from '@/services/thumbnail-service';
import { cn } from '@/utils/format';

export function SourceWaveform({
  peaks,
  progress,
  className,
}: {
  peaks?: number[];
  progress: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () =>
      drawWaveform(canvas, peaks, {
        color: '#5fd0a0',
        background: '#101a16',
        progress,
        gridLines: true,
      });
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, progress]);

  return (
    <div
      className={cn(
        'relative h-[150px] w-full max-w-[560px] overflow-hidden rounded-[3px] border border-[#2c443b] bg-[#101a16]',
        className,
      )}
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
      {!peaks || peaks.length === 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-app-textFaint">
          <AudioLines size={22} strokeWidth={1.5} />
          <span className="text-2xs">Waveform unavailable</span>
        </div>
      ) : null}
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-white/75"
        style={{ left: `${Math.max(0, Math.min(100, progress * 100))}%` }}
      />
    </div>
  );
}
