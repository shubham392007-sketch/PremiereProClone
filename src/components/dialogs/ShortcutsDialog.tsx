import { Keyboard } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { Modal } from '@/components/common/Modal';

interface ShortcutRow {
  keys: string[];
  action: string;
  group: string;
}

export const SHORTCUTS: ShortcutRow[] = [
  { group: 'Playback', keys: ['Space'], action: 'Play / Pause' },
  { group: 'Playback', keys: ['K'], action: 'Pause' },
  { group: 'Playback', keys: ['J'], action: 'Reverse play' },
  { group: 'Playback', keys: ['L'], action: 'Forward play (press repeatedly for 2×, 4×)' },
  { group: 'Playback', keys: ['←'], action: 'Previous frame' },
  { group: 'Playback', keys: ['→'], action: 'Next frame' },
  { group: 'Playback', keys: ['Home'], action: 'Go to sequence start' },
  { group: 'Playback', keys: ['End'], action: 'Go to sequence end' },
  { group: 'Tools', keys: ['V'], action: 'Selection tool' },
  { group: 'Tools', keys: ['C'], action: 'Razor tool' },
  { group: 'Tools', keys: ['H'], action: 'Hand tool' },
  { group: 'Tools', keys: ['Z'], action: 'Zoom tool' },
  { group: 'Editing', keys: ['Ctrl', 'Z'], action: 'Undo' },
  { group: 'Editing', keys: ['Ctrl', 'Shift', 'Z'], action: 'Redo' },
  { group: 'Editing', keys: ['Ctrl', 'S'], action: 'Save project' },
  { group: 'Editing', keys: ['Ctrl', 'C'], action: 'Copy selected clips' },
  { group: 'Editing', keys: ['Ctrl', 'V'], action: 'Paste at playhead' },
  { group: 'Editing', keys: ['Ctrl', 'X'], action: 'Cut selected clips' },
  { group: 'Editing', keys: ['Delete'], action: 'Delete selected clips' },
  { group: 'Editing', keys: ['Ctrl', 'A'], action: 'Select all clips' },
  { group: 'Editing', keys: ['Ctrl', 'K'], action: 'Split selected clips at playhead' },
  { group: 'Editing', keys: ['Ctrl', 'Shift', 'K'], action: 'Split all clips at playhead' },
  { group: 'Editing', keys: ['Ctrl', 'D'], action: 'Duplicate selected clips' },
  { group: 'Editing', keys: ['Alt', '←/→'], action: 'Nudge selected clips one frame' },
  { group: 'Navigation', keys: ['+'], action: 'Zoom in timeline' },
  { group: 'Navigation', keys: ['-'], action: 'Zoom out timeline' },
  { group: 'Navigation', keys: ['\\'], action: 'Zoom to fit sequence' },
  { group: 'Markers', keys: ['M'], action: 'Add marker at playhead' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function ShortcutsDialog() {
  const open = useWorkspaceStore((s) => s.dialogs.shortcuts);
  const closeDialog = useWorkspaceStore((s) => s.closeDialog);

  return (
    <Modal
      open={open}
      title="Keyboard Shortcuts"
      subtitle="Shortcuts are disabled while typing in a text field"
      onClose={() => closeDialog('shortcuts')}
      width={560}
      footer={
        <button type="button" className="btn" onClick={() => closeDialog('shortcuts')}>
          Close
        </button>
      }
    >
      <div className="p-4">
        <div className="mb-3 flex items-center gap-2 border border-app-border bg-[#1d1d1d] px-3 py-2 text-2xs text-app-textDim">
          <Keyboard size={13} />
          {isMac ? 'Use ⌘ in place of Ctrl on macOS.' : 'Use Ctrl for the shortcuts below.'}
        </div>
        <table className="w-full border-collapse text-xs">
          <tbody>
            {SHORTCUTS.map((shortcut, index) => {
              const prev = SHORTCUTS[index - 1];
              const showGroup = !prev || prev.group !== shortcut.group;
              return (
                <tr key={`${shortcut.action}-${index}`} className="group">
                  <td className="w-[152px] py-1 pr-3 align-middle">
                    {showGroup ? (
                      <span className="text-3xs font-semibold uppercase tracking-[0.14em] text-app-textFaint">
                        {shortcut.group}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <kbd
                          key={key}
                          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-[#4a4a4a] bg-[#2d2d2d] px-1 font-mono text-3xs text-app-text"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </td>
                  <td className="border-b border-[#2b2b2b] py-1 text-app-textDim">{shortcut.action}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
