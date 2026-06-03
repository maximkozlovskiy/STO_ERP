'use client';

import { useState, useEffect } from 'react';

/**
 * Keeps an element in the DOM during its exit animation.
 *
 * - `visible`  — controls DOM presence (replaces `if (!open) return null`)
 * - `state`    — "open" | "closed" — drives data-state CSS animations
 *
 * Pattern:
 *   open=true  → visible=true,  state="open"   → CSS enter animation
 *   open=false → state="closed" → CSS exit animation → setTimeout → visible=false
 *
 * Usage:
 *   const { visible, state } = useAnimatedPresence(open);
 *   if (!visible) return null;
 *   return <div data-state={state}>{children}</div>;
 */
export function useAnimatedPresence(open: boolean, exitDuration = 180) {
  const [visible, setVisible] = useState(open);
  const [state, setState] = useState<'open' | 'closed'>(open ? 'open' : 'closed');

  useEffect(() => {
    if (open) {
      // Make visible first, then on next frame set state="open" so the
      // browser has time to attach the element before the animation starts.
      setVisible(true);
      const raf = requestAnimationFrame(() => setState('open'));
      return () => cancelAnimationFrame(raf);
    } else {
      // Start exit animation, remove from DOM after it completes.
      setState('closed');
      const t = setTimeout(() => setVisible(false), exitDuration);
      return () => clearTimeout(t);
    }
  }, [open, exitDuration]);

  return { visible, state };
}
