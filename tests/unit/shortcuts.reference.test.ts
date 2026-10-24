import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_GROUPS,
  isHelpShortcut,
  isTypingTarget,
  layoutForShortcut,
  timeframeForShortcut,
} from '../../src/lib/shortcuts/reference';

describe('shortcut reference', () => {
  it('keeps group and entry ids unique and every entry documented', () => {
    const groupIds = SHORTCUT_GROUPS.map((group) => group.id);
    expect(new Set(groupIds).size).toBe(groupIds.length);

    const entryIds = SHORTCUT_GROUPS.flatMap((group) => group.entries.map((entry) => entry.id));
    expect(new Set(entryIds).size).toBe(entryIds.length);

    for (const group of SHORTCUT_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.keys.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('documents the existing and new bindings in their scopes', () => {
    const keysFor = (id: string) =>
      SHORTCUT_GROUPS.flatMap((group) => group.entries).find((entry) => entry.id === id)?.keys;

    expect(keysFor('palette')).toEqual(['Ctrl/Cmd', 'K']);
    expect(keysFor('reference')).toEqual(['?']);
    expect(keysFor('timeframe')).toEqual(['1', '2', '3']);
    expect(keysFor('fit')).toEqual(['F']);
    expect(keysFor('layout-single')).toEqual(['Alt', 'Shift', '1']);
    expect(keysFor('layout-four')).toEqual(['Alt', 'Shift', '4']);
    expect(SHORTCUT_GROUPS.find((group) => group.id === 'workspace')?.entries).toHaveLength(4);
  });
});

describe('isHelpShortcut', () => {
  const base = { key: '?', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true };

  it('accepts the shifted question mark and rejects modifiers', () => {
    expect(isHelpShortcut(base)).toBe(true);
    expect(isHelpShortcut({ ...base, key: '?', shiftKey: false })).toBe(true);
    expect(isHelpShortcut({ ...base, key: '/', shiftKey: true })).toBe(true);
    expect(isHelpShortcut({ ...base, key: '/', shiftKey: false })).toBe(false);
    expect(isHelpShortcut({ ...base, ctrlKey: true })).toBe(false);
    expect(isHelpShortcut({ ...base, metaKey: true })).toBe(false);
    expect(isHelpShortcut({ ...base, altKey: true })).toBe(false);
    expect(isHelpShortcut({ ...base, key: 'k' })).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('protects form controls and editable content', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'select' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', closest: () => ({}) })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', closest: () => null })).toBe(false);
  });
});

describe('timeframeForShortcut', () => {
  it('maps number keys onto the timeframes the dataset can actually produce', () => {
    expect(timeframeForShortcut('1', 'daily')).toBe('1D');
    expect(timeframeForShortcut('2', 'daily')).toBe('1W');
    expect(timeframeForShortcut('3', 'daily')).toBe('1M');
    expect(timeframeForShortcut('1', 'weekly')).toBe('1W');
    expect(timeframeForShortcut('2', 'weekly')).toBeNull();
    expect(timeframeForShortcut('1', 'monthly')).toBe('1M');
    expect(timeframeForShortcut('3', 'monthly')).toBeNull();
    expect(timeframeForShortcut('4', 'daily')).toBeNull();
    expect(timeframeForShortcut('f', 'daily')).toBeNull();
  });

  it('uses the physical digit so shifted number layouts still work', () => {
    expect(timeframeForShortcut('!', 'daily', 'Digit1')).toBe('1D');
    expect(timeframeForShortcut('@', 'daily', 'Digit2')).toBe('1W');
    expect(timeframeForShortcut('2', 'daily', 'Numpad2')).toBe('1W');
    expect(timeframeForShortcut('2', 'daily', 'KeyF')).toBe('1W');
    expect(timeframeForShortcut('2', 'daily', 'Digit9')).toBeNull();
  });
});

describe('layoutForShortcut', () => {
  const base = {
    key: '1',
    code: 'Digit1',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
  };

  it('maps Alt+Shift+1..4 onto the stored layout order', () => {
    expect(layoutForShortcut(base)).toBe('single');
    expect(layoutForShortcut({ ...base, key: '2', code: 'Digit2' })).toBe('two-horizontal');
    expect(layoutForShortcut({ ...base, key: '3', code: 'Digit3' })).toBe('two-vertical');
    expect(layoutForShortcut({ ...base, key: '4', code: 'Digit4' })).toBe('four');
  });

  it('uses the physical digit when Alt changes the typed character', () => {
    expect(layoutForShortcut({ ...base, key: '¡', code: 'Digit1' })).toBe('single');
    expect(layoutForShortcut({ ...base, key: '@', code: 'Digit2' })).toBe('two-horizontal');
    expect(layoutForShortcut({ ...base, key: '1', code: 'Numpad1' })).toBe('single');
  });

  it('ignores other modifiers and out-of-range keys', () => {
    expect(layoutForShortcut({ ...base, altKey: false })).toBeNull();
    expect(layoutForShortcut({ ...base, ctrlKey: true })).toBeNull();
    expect(layoutForShortcut({ ...base, metaKey: true })).toBeNull();
    expect(layoutForShortcut({ ...base, shiftKey: false })).toBeNull();
    expect(layoutForShortcut({ ...base, key: '5', code: 'Digit5' })).toBeNull();
    expect(layoutForShortcut({ ...base, key: 'a', code: 'KeyA' })).toBeNull();
  });
});
