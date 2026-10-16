/**
 * Consensus type — the type every candidate of an ambiguous member agrees on
 * (bd tea-rags-mcp-2m83f.42).
 *
 * An overflow site (`record.firm` with an untyped `record`) has no single
 * target, but when every candidate declares the same return the hop's TYPE is
 * still known: every `belongs_to :firm` reader yields `Firm`. The chain fold
 * reaches this through {@link ReceiverTypePorts.ownerIndependentMemberType}, so
 * the walk resumes from the agreed type and only the hop itself stays without
 * an edge.
 *
 * Refusal is the default, because a wrong receiver type poisons every hop after
 * it: fewer than `minCandidates` candidates is a namesake, not a consensus; one
 * candidate whose type the language cannot read silences the fold; two that
 * disagree silence it.
 */

/** Fewer candidates than this is one namesake guessed at, not an agreement. */
export const CONSENSUS_MIN_CANDIDATES = 2;

export function consensusType<C, T>(
  candidates: readonly C[],
  typeOf: (candidate: C) => T | undefined,
  equals: (a: T, b: T) => boolean,
  minCandidates: number = CONSENSUS_MIN_CANDIDATES,
): T | undefined {
  if (candidates.length < minCandidates) return undefined;
  let agreed: T | undefined;
  for (const candidate of candidates) {
    const type = typeOf(candidate);
    if (type === undefined) return undefined;
    if (agreed === undefined) agreed = type;
    else if (!equals(agreed, type)) return undefined;
  }
  return agreed;
}
