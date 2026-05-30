'use client';

import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-destructive-subtle flex items-center justify-center mx-auto">
          <svg
            className="w-8 h-8 text-destructive-text"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-foreground">Виникла помилка</h2>
        <p className="text-muted-foreground text-[14px]">
          {error.message || 'Щось пішло не так. Спробуйте оновити сторінку.'}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-primary text-white text-[14px] font-medium hover:bg-primary-dark transition-colors"
          >
            Спробувати знову
          </button>
          <button
            onClick={() => (window.location.href = '/dashboard')}
            className="px-4 py-2 rounded-lg border border-border text-foreground text-[14px] font-medium hover:bg-secondary transition-colors"
          >
            На головну
          </button>
        </div>
      </div>
    </div>
  );
}
