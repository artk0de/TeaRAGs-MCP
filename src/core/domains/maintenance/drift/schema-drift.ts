export interface SchemaDrift {
  added: string[];
  removed: string[];
}

/** Compare cached payload keys vs current. Returns null if no drift or no cached keys. */
export function checkSchemaDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
  if (!cachedKeys) return null;
  const cachedSet = new Set(cachedKeys);
  const currentSet = new Set(currentKeys);
  const added = currentKeys.filter((k) => !cachedSet.has(k));
  const removed = cachedKeys.filter((k) => !currentSet.has(k));
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}
