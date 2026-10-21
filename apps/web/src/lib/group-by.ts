/**
 * Групує елементи за ключем в один прохід. Замість `map.set(k, [...(map.get(k) ?? []), x])`, яке
 * копіює масив на кожну вставку.
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
