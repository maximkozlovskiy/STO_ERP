'use client';

import { useEffect } from 'react';

export interface ShortcutOptions {
  enabled?: boolean;
  /** When true, fires even if focus is inside an input/textarea/select/contenteditable */
  allowInInput?: boolean;
}

/**
 * Registers a keyboard shortcut.
 *
 * Key format: 'ctrl+k', 'alt+n', 'escape', 'shift+?'
 * Single char (no modifier): fires only when focus is NOT in an input field.
 */
export function useKeyboardShortcut(
  key: string,
  handler: (e: KeyboardEvent) => void,
  { enabled = true, allowInInput = false }: ShortcutOptions = {},
) {
  useEffect(() => {
    if (!enabled) return;

    const parts = key.toLowerCase().split('+');
    const needsCtrl  = parts.includes('ctrl');
    const needsAlt   = parts.includes('alt');
    const needsShift = parts.includes('shift');
    const mainKey    = parts[parts.length - 1];

    const listener = (e: KeyboardEvent) => {
      if (needsCtrl  !== e.ctrlKey)  return;
      if (needsAlt   !== e.altKey)   return;
      if (needsShift !== e.shiftKey) return;
      if (e.key.toLowerCase() !== mainKey && e.code.toLowerCase() !== `key${mainKey}`) return;

      if (!allowInInput) {
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        ) return;
      }

      handler(e);
    };

    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [key, handler, enabled, allowInInput]);
}
