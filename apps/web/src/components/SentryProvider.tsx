'use client';

import { useEffect } from 'react';
import { initSentry } from '@/lib/sentry';

/** Initialises Sentry once on the client side. Must be inside the component tree. */
export function SentryProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initSentry();
  }, []);

  return <>{children}</>;
}
