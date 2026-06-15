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
