/**
 * How a class-body hook folds its sub-floor groups: which group is noise, whether
 * a merged group still fits the chunk budget, how two groups merge, and where a
 * group starts in the source. The group shape stays the hook's own (Ruby folds
 * line groups, TypeScript node groups).
 */
export interface SubFloorGroupFold<G> {
  isSubFloor: (group: G) => boolean;
  fits: (group: G) => boolean;
  merge: (host: G, guest: G) => G;
  startOf: (group: G) => number;
}

/**
 * Body groups with every group under the 50-char noise floor folded into a
 * neighbour instead of dropped (bd tea-rags-mcp-30qdc, tea-rags-mcp-xiki8):
 * once a class-body hook writes a body chunk the engine's container remainder
 * stays out, so a dropped row (`private` / a lone `include` in Ruby, a lone
 * `private n = 1;` in TypeScript) was in no chunk at all. A sub-floor group
 * joins the group before it, else the next one, whichever still fits the
 * budget; one no neighbour can host stays a group of its own. When EVERY group
 * is under the floor nothing comes back — the hook then writes no body chunk
 * and the engine's remainder keeps those rows (bd tea-rags-mcp-6xdwe).
 */
export function foldSubFloorGroups<G>(groups: G[], fold: SubFloorGroupFold<G>): G[] {
  const { isSubFloor, fits, merge, startOf } = fold;
  if (groups.every(isSubFloor)) return [];

  const kept: G[] = [];
  let pendingGroups: G[] = [];
  const foldIntoLast = (guest: G): boolean => {
    const last = kept.at(-1);
    if (last === undefined) return false;
    const intoLast = merge(last, guest);
    if (!fits(intoLast)) return false;
    kept[kept.length - 1] = intoLast;
    return true;
  };
  for (const group of groups) {
    if (isSubFloor(group)) {
      if (!foldIntoLast(group)) pendingGroups.push(group);
      continue;
    }
    let host = group;
    for (const guest of pendingGroups) {
      const intoHost = merge(host, guest);
      if (fits(intoHost)) host = intoHost;
      else kept.push(guest);
    }
    pendingGroups = [];
    kept.push(host);
  }
  for (const guest of pendingGroups) {
    if (!foldIntoLast(guest)) kept.push(guest);
  }
  return kept.sort((a, b) => startOf(a) - startOf(b));
}
