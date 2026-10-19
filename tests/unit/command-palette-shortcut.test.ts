import { describe, expect, it } from 'vitest';
import { isMacPlatform, isPaletteShortcut, shortcutLabel } from '../../src/lib/command-palette/platform';

const press = (key: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe('isPaletteShortcut', () => {
  it('accepts Ctrl+K and Cmd+K', () => {
    expect(isPaletteShortcut(press('k', { ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(press('K', { metaKey: true }))).toBe(true);
  });

  it('accepts Ctrl/Cmd+Shift+P as the alias', () => {
    expect(isPaletteShortcut(press('p', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPaletteShortcut(press('P', { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('ignores unmodified keys and unrelated chords', () => {
    expect(isPaletteShortcut(press('k'))).toBe(false);
    expect(isPaletteShortcut(press('k', { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isPaletteShortcut(press('p', { ctrlKey: true }))).toBe(false);
    expect(isPaletteShortcut(press('k', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(press('z', { ctrlKey: true }))).toBe(false);
  });
});

describe('platform wording', () => {
  it('detects Apple platforms', () => {
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('iPhone')).toBe(true);
    expect(isMacPlatform('Win32')).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
    expect(isMacPlatform('')).toBe(false);
  });

  it('labels the shortcut per platform', () => {
    expect(shortcutLabel(true)).toBe('⌘K');
    expect(shortcutLabel(false)).toBe('Ctrl K');
  });
});
