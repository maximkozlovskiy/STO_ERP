'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface TooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <span
      ref={ref}
      onMouseEnter={() => {
        if (ref.current) setRect(ref.current.getBoundingClientRect());
      }}
      onMouseLeave={() => setRect(null)}
      className={cn('inline-flex', className)}
    >
      {children}
      {mounted &&
        rect &&
        createPortal(
          <span
            style={{
              position: 'fixed',
              left: rect.left + rect.width / 2,
              top: rect.top - 8,
              transform: 'translate(-50%, -100%)',
            }}
            className="pointer-events-none z-9999 w-max max-w-65 rounded-md bg-foreground px-2.5 py-1.5 text-[12px] leading-snug text-background shadow-md whitespace-normal text-center font-normal"
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
