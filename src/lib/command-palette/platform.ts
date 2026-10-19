/**
 * Platform-specific keyboard wording, so the palette and its trigger label the
 * shortcut the way the user's operating system does (⌘K on macOS, Ctrl K
 * elsewhere). Kept separate from the component so it is unit-testable.
 */

export function isMacPlatform(platform: string | undefined | null): boolean {
  return typeof platform === 'string' && /mac|iphone|ipad|ipod/i.test(platform);
}

export function shortcutLabel(isMac: boolean): string {
  return isMac ? '⌘K' : 'Ctrl K';
}

/** True when the event was the palette shortcut on any platform. */
export function isPaletteShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return false;
  const key = event.key.toLowerCase();
  // Ctrl/Cmd+K, plus Ctrl/Cmd+Shift+P as an alias (nothing in the app binds it).
  return (key === 'k' && !event.shiftKey) || (key === 'p' && event.shiftKey);
}
