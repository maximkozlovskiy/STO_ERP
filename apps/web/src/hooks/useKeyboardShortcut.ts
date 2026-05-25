'use client';

import { useEffect } from 'react';

export interface ShortcutOptions {
  enabled?: boolean;
  /** When true, fires even if focus is inside an input/textarea/select/contenteditable */
  allowInInput?: boolean;
}

/** Aliases that map a printable Shift-modified character to its base key. */
const SHIFT_ALIAS: Record<string, string> = {
  '?': '/',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  '_': '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '~': '`',
};

/**
 * Registers a keyboard shortcut.
 *
 * Key format: 'ctrl+k', 'alt+n', 'escape', 'shift+/'
 * Single char (no modifier): fires only when focus is NOT in an input field.
 *
 * Notes:
 * - For 'shift+/' on a US layout, browsers report e.key='?' — we normalize via SHIFT_ALIAS.
 * - e.code is layout-independent ('KeyA', 'Slash', 'Digit1') and is also checked
 *   as a fallback for non-US layouts where e.key may differ.
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

    const matchesMain = (e: KeyboardEvent): boolean => {
      const k = e.key.toLowerCase();
      // Normalize Shift-modified char back to base (e.g. '?' → '/')
      const normalized = SHIFT_ALIAS[k] ?? k;
      if (k === mainKey || normalized === mainKey) return true;
      // Fallback: layout-independent physical key match
      const code = e.code.toLowerCase();
      if (mainKey.length === 1 && /[a-z]/.test(mainKey) && code === `key${mainKey}`) return true;
      if (mainKey.length === 1 && /[0-9]/.test(mainKey) && code === `digit${mainKey}`) return true;
      if (mainKey === '/' && code === 'slash') return true;
      return false;
    };

    const listener = (e: KeyboardEvent) => {
      if (needsCtrl  !== e.ctrlKey)  return;
      if (needsAlt   !== e.altKey)   return;
      if (needsShift !== e.shiftKey) return;
      if (!matchesMain(e)) return;

      if (!allowInInput) {
        const target = e.target as HTMLElement | null;
        if (target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        )) return;
      }

      handler(e);
    };

    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [key, handler, enabled, allowInInput]);
}
