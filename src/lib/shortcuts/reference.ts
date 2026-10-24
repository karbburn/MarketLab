/**
 * Keyboard reference and key-decoding helpers.
 *
 * The reference is data, not JSX, so the dialog, the workspace panel and the
 * unit tests all read one list. Helpers stay free of React and of the DOM so
 * they can be tested in Node; `isTypingTarget` only duck-types the handful of
 * element properties it needs.
 */

import type { Frequency, Timeframe, WorkspaceLayout } from '../../domain/types';
import { WORKSPACE_LAYOUTS } from '../../state/defaults';
import { availableTimeframes } from '../timeframe';

export type ShortcutScope = 'global' | 'chart' | 'workspace';

export interface ShortcutEntry {
  id: string;
  /** Individual key caps, rendered one `<kbd>` each. */
  keys: readonly string[];
  description: string;
  note?: string;
}

export interface ShortcutGroup {
  id: ShortcutScope;
  label: string;
  description: string;
  entries: readonly ShortcutEntry[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: 'global',
    label: 'Anywhere',
    description: 'Available from any view. Browser and operating-system shortcuts always take precedence.',
    entries: [
      {
        id: 'palette',
        keys: ['Ctrl/Cmd', 'K'],
        description: 'Open the command palette.',
        note: 'This is the one binding that also works while you are typing.',
      },
      {
        id: 'palette-alias',
        keys: ['Ctrl/Cmd', 'Shift', 'P'],
        description: 'Open the command palette (alias).',
      },
      {
        id: 'reference',
        keys: ['?'],
        description: 'Open this keyboard reference.',
        note: 'Ignored while typing in a form control or while another dialog is open.',
      },
      {
        id: 'close-dialog',
        keys: ['Esc'],
        description: 'Close the topmost dialog or cancel the active tool.',
      },
    ],
  },
  {
    id: 'chart',
    label: 'Focused chart',
    description:
      'These keys act on the focused panel. They never fire while focus is in an input, select, textarea or editable element.',
    entries: [
      {
        id: 'timeframe',
        keys: ['1', '2', '3'],
        description: 'Switch to the first, second or third available timeframe.',
        note: 'A weekly series has one timeframe, so only 1 does anything there.',
      },
      {
        id: 'fit',
        keys: ['F'],
        description: 'Fit the visible bars to the panel.',
      },
      {
        id: 'cancel',
        keys: ['Esc'],
        description: 'Cancel a half-drawn shape, return to the pointer tool and clear the selection.',
      },
      {
        id: 'delete',
        keys: ['Delete', 'Backspace'],
        description: 'Delete the selected drawing.',
      },
      {
        id: 'undo',
        keys: ['Ctrl/Cmd', 'Z'],
        description: 'Undo the last drawing change.',
      },
      {
        id: 'redo',
        keys: ['Ctrl/Cmd', 'Shift', 'Z'],
        description: 'Redo the last undone drawing change.',
      },
      {
        id: 'endpoint',
        keys: ['[', ']'],
        description: 'Choose the previous or next endpoint of the selected drawing.',
      },
      {
        id: 'nudge',
        keys: ['Arrow keys'],
        description: 'Move the chosen endpoint by one session or one price step.',
        note: 'Hold Shift for five sessions or ten price steps.',
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    description:
      'Layout changes apply to the active workspace and are persisted like the layout control. Alt+Shift+number is used because Alt+number switches browser tabs in some browsers.',
    entries: [
      {
        id: 'layout-single',
        keys: ['Alt', 'Shift', '1'],
        description: 'Single panel.',
      },
      {
        id: 'layout-stacked',
        keys: ['Alt', 'Shift', '2'],
        description: 'Two stacked panels.',
      },
      {
        id: 'layout-side-by-side',
        keys: ['Alt', 'Shift', '3'],
        description: 'Two panels side by side.',
      },
      {
        id: 'layout-four',
        keys: ['Alt', 'Shift', '4'],
        description: 'Four panels.',
      },
    ],
  },
];

/** True for the `?` key, allowing the Shift that produces it on most layouts. */
export function isHelpShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  // Browsers report `?` for Shift+/ on most layouts; some automation and
  // non-US layouts report the underlying slash with Shift held.
  return event.key === '?' || (event.key === '/' && event.shiftKey);
}

/**
 * Whether a key event originated in a control that must receive the character
 * itself. `closest` covers contenteditable descendants; the tag fallback keeps
 * the helper usable with plain objects in unit tests.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  if (element.isContentEditable) return true;
  if (typeof element.closest === 'function') {
    return Boolean(element.closest('input, select, textarea, [contenteditable="true"]'));
  }
  const tag = element.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

/**
 * The timeframe a number key selects on a panel showing `frequency`, or null
 * when that slot does not exist. Keys map to the available list, so a weekly
 * series uses `1` for weekly rather than pretending a daily view exists.
 *
 * `code` is preferred when present so the binding follows the physical digit
 * key on layouts where Shift is needed to type a number.
 */
export function timeframeForShortcut(key: string, frequency: Frequency, code?: string): Timeframe | null {
  const fromCode = /^(?:Digit|Numpad)(\d)$/.exec(code ?? '');
  const slot = fromCode ? Number(fromCode[1]) : /^[1-9]$/.test(key) ? Number(key) : 0;
  if (slot < 1 || slot > 3) return null;
  const options = availableTimeframes(frequency);
  return options[slot - 1] ?? null;
}

/**
 * The layout an Alt+Shift+number event selects, or null when the event is not
 * one. Alt+number alone is deliberately not used: Firefox reserves it for tab
 * switching, and the reference says browser shortcuts take precedence.
 */
export function layoutForShortcut(event: {
  key: string;
  code?: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): WorkspaceLayout | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
  const fromCode = /^(?:Digit|Numpad)(\d)$/.exec(event.code ?? '');
  const slot = fromCode ? Number(fromCode[1]) : /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
  if (slot < 1 || slot > 4) return null;
  return WORKSPACE_LAYOUTS[slot - 1]?.id ?? null;
}
