'use client';

import { useState, useCallback } from 'react';

export type SortDir = 'asc' | 'desc';
export interface SortState {
  sortBy: string;
  sortDir: SortDir;
}

export function useSortState(defaultBy: string, defaultDir: SortDir = 'desc') {
  const [sort, setSort] = useState<SortState>({ sortBy: defaultBy, sortDir: defaultDir });

  const toggle = useCallback((key: string) => {
    setSort(prev =>
      prev.sortBy === key
        ? { sortBy: key, sortDir: prev.sortDir === 'asc' ? 'desc' : 'asc' }
        : { sortBy: key, sortDir: 'asc' },
    );
  }, []);

  return { sort, toggle };
}
