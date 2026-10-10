/**
 * Python's C3 method resolution order over class KEYS
 * (`<relPath>::<dotted class FQ>`), bd tea-rags-mcp-y4hro.
 *
 * ORDER is the half of an ancestor walk that no language shares. Ruby answers
 * the same question with module insertion (prepends, the class, includes ranked
 * last-declared-nearest, then the superclass chain); Python answers it with the
 * C3 merge. This module owns Python's answer and nothing else — the recursion
 * driver, the per-path cycle guard, the per-run memo and the member scan belong
 * to the neutral kernel walk, and `findMemberInAncestorChain` consumes what is
 * returned here.
 *
 * The module is PURE and has zero imports by design. `basesOf` is the port: it
 * hands back base class KEYS, already resolved from the walker's
 * import-qualified spellings (`a.b::Base`) by whoever owns a `CallContext`, a
 * symbol table and the import file mapper. That resolution is also where a base
 * that left the project is recorded as an external or an unknown boundary —
 * `linearizeC3` visits every reachable class exactly the once it needs to, so a
 * caller can accumulate those flags inside its own `basesOf` closure.
 *
 * Keeping resolution out here is what makes an MRO CALLER-INDEPENDENT: a base
 * spelling carries its DEFINING file's import binding, never the asking file's,
 * so `MRO(RepositoryBase)` is the same order whichever call site wants it, and
 * memoizing it once per run is sound.
 */

/** A linearized ancestor order, plus how often C3 had to give up producing it. */
export interface PythonMroOutcome {
  /** The class itself first, then its ancestors nearest-first. Never repeats a key. */
  readonly order: readonly string[];
  /**
   * Inconsistent-hierarchy count. `0` is a true C3 order; anything higher means
   * the DFS fallback produced part of `order`. The gate prints it — a silent
   * fallback is an unmeasured order.
   */
  readonly fallbacks: number;
}

/**
 * `L(C) = [C] + merge(L(B1), …, L(Bn), [B1, …, Bn])` over the resolved base
 * keys, with a per-path cycle guard so a hierarchy that loops still terminates
 * with each key present once.
 *
 * A base whose linearization comes back empty was cut by the cycle guard, and
 * it is dropped from the constraint sequence too — leaving it there would
 * reintroduce the key the guard just removed.
 */
export function linearizeC3(classKey: string, basesOf: (classKey: string) => readonly string[]): PythonMroOutcome {
  let fallbacks = 0;

  const linearize = (key: string, path: ReadonlySet<string>): string[] => {
    if (path.has(key)) return [];
    const nextPath = new Set(path).add(key);

    const parents: string[] = [];
    const seen = new Set<string>();
    for (const base of basesOf(key)) {
      // `class C(A, A)` is a TypeError in Python but a shape a walker can emit;
      // a repeated head would survive the merge, which strikes one occurrence
      // at a time.
      if (seen.has(base)) continue;
      seen.add(base);
      parents.push(base);
    }
    if (parents.length === 0) return [key];

    const sequences: string[][] = [];
    const live: string[] = [];
    for (const parent of parents) {
      const linearized = linearize(parent, nextPath);
      if (linearized.length === 0) continue;
      sequences.push(linearized);
      live.push(parent);
    }
    if (live.length === 0) return [key];

    const merged = c3Merge([...sequences, live]);
    if (merged !== null) return [key, ...merged];

    // Inconsistent hierarchy. A lookup still has to answer, so fall back to
    // left-to-right DFS with first-occurrence-wins dedupe, and COUNT it.
    fallbacks += 1;
    const out = [key];
    const emitted = new Set<string>([key]);
    for (const sequence of sequences) {
      for (const ancestor of sequence) {
        if (emitted.has(ancestor)) continue;
        emitted.add(ancestor);
        out.push(ancestor);
      }
    }
    return out;
  };

  return { order: linearize(classKey, new Set()), fallbacks };
}

/**
 * The C3 merge. Repeatedly take the head of the first sequence that appears in
 * no other sequence's TAIL; append it and strike it from every sequence. `null`
 * when no such head exists — an inconsistent hierarchy, which Python reports as
 * `TypeError: Cannot create a consistent method resolution order`. Never
 * throws: the caller owns the fallback and the counter.
 */
function c3Merge(sequences: readonly (readonly string[])[]): string[] | null {
  const pending = sequences.map((sequence) => [...sequence]);
  const out: string[] = [];
  for (;;) {
    const live = pending.filter((sequence) => sequence.length > 0);
    if (live.length === 0) return out;
    let head: string | null = null;
    for (const sequence of live) {
      const candidate = sequence[0];
      if (candidate === undefined) continue;
      if (live.some((other) => other.indexOf(candidate) > 0)) continue;
      head = candidate;
      break;
    }
    if (head === null) return null;
    out.push(head);
    for (const sequence of pending) {
      const at = sequence.indexOf(head);
      if (at !== -1) sequence.splice(at, 1);
    }
  }
}
