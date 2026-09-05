/** Унікальні ненульові id зі списку сирих FK-значень. */
export function uniqueDefinedIds(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/** Zero-init мапа лічильників для кожного id. */
export function initCountsMap<K extends string>(
  ids: string[],
  keys: readonly K[],
): Record<string, Record<K, number>> {
  const out: Record<string, Record<K, number>> = {};
  for (const id of ids) out[id] = Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;
  return out;
}
