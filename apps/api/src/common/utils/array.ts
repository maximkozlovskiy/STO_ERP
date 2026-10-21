/**
 * Deduplicate an array by a key function, keeping the LAST occurrence of each key
 * (last-write-wins semantics — consistent with Map insertion order).
 *
 * Used for bulk-update plans where the same PK may appear multiple times
 * (e.g. PO lines or xlsx rows with the same goodId).
 */
export function deduplicateBy<T>(arr: T[], key: (item: T) => unknown): T[] {
  return Array.from(new Map(arr.map(u => [key(u), u])).values());
}

/**
 * Групує елементи за ключем в один прохід. Замість `map.set(k, [...(map.get(k) ?? []), x])`, яке
 * копіює масив на кожну вставку (O(n²) на групу).
 */
export function groupBy<T, K>(arr: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    const group = out.get(k);
    if (group) group.push(item);
    else out.set(k, [item]);
  }
  return out;
}
