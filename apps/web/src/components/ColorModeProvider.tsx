'use client';

import { useEffect, type ReactNode } from 'react';
import { applyColorMode, watchSystemColorMode } from '@/lib/color-mode';

export function ColorModeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyColorMode();
    return watchSystemColorMode();
  }, []);
  return <>{children}</>;
}
