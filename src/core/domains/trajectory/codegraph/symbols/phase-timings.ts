/**
 * Wall-clock attribution for a codegraph enrichment run (bd tea-rags-mcp-6aytq).
 *
 * A force-resolve over a large TypeScript project runs for tens of minutes
 * inside the collection-affinity worker thread, and until now nothing inside it
 * carried a timestamp: `CODEGRAPH_PASS2_PROGRESS` reported counts, never time,
 * and no per-language number existed anywhere. So "pass-2 is slow" and "the TS
 * walker is slow" were indistinguishable, and any optimisation was a guess.
 *
 * This accumulator is pure observation — it records, it never decides. Every
 * `record` is two number additions, so the pass-1/pass-2 per-file call sites
 * pay effectively nothing; the periodic DEBUG lines that read it are the only
 * I/O, and they are gated on `isDebug()` at the call site.
 *
 * Lifetime is the provider instance, which in the enrichment pool is one
 * (collection, run) pair — the worker builds the provider on the run's first
 * dispatch and drops it on `release`. That is why there is no `reset()`: a
 * second run gets a second provider, hence a second accumulator.
 */

/** The five stages a codegraph run's wall clock can land in. */
export type CodegraphPhase = "pass1" | "pass2" | "flush" | "checkpoint" | "metrics";

/** Every phase, in the order the summary line renders them. */
const CODEGRAPH_PHASES: readonly CodegraphPhase[] = ["pass1", "pass2", "flush", "checkpoint", "metrics"];

/**
 * What one recorded unit MEANS per phase — the pass phases record one file per
 * call, the rest record one invocation. Named in the summary so a reader does
 * not have to know which is which.
 */
const PHASE_UNIT: Record<CodegraphPhase, "files" | "calls"> = {
  pass1: "files",
  pass2: "files",
  flush: "calls",
  checkpoint: "calls",
  metrics: "calls",
};

/** Accumulated wall clock plus how many units produced it. */
export interface CodegraphPhaseTotal {
  ms: number;
  count: number;
}

export interface CodegraphPhaseTimingsSnapshot {
  /** Wall clock since the accumulator was constructed. */
  elapsedMs: number;
  /** Per-phase totals — always all five keys, zeroed when never recorded. */
  phases: Record<CodegraphPhase, CodegraphPhaseTotal>;
  /** Per-phase language split; `{}` for a phase nothing labelled. */
  byLanguage: Record<CodegraphPhase, Record<string, CodegraphPhaseTotal>>;
}

export interface CodegraphPhaseRecordOptions {
  /** Language of the file this duration belongs to; omitted for whole-run work. */
  language?: string;
  /** Units this duration covers — a bulk flush of 256 files records once. */
  count?: number;
}

function emptyTotal(): CodegraphPhaseTotal {
  return { ms: 0, count: 0 };
}

export class CodegraphPhaseTimings {
  private readonly startedAtMs: number;
  private readonly totals = new Map<CodegraphPhase, CodegraphPhaseTotal>();
  private readonly perLanguage = new Map<CodegraphPhase, Map<string, CodegraphPhaseTotal>>();

  /**
   * @param now Clock read for `elapsedMs`. Injected so tests get determinism
   *   without faking timers; production leaves it on `Date.now`.
   */
  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
  }

  /**
   * Fold one measurement in. A negative / non-finite duration is clamped to
   * zero rather than rejected: this runs on the resolve hot path in a
   * diagnostics-only role, so poisoning the totals is the worst acceptable
   * outcome and throwing is not an outcome at all.
   */
  record(phase: CodegraphPhase, durationMs: number, options?: CodegraphPhaseRecordOptions): void {
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    const count = options?.count ?? 1;

    let total = this.totals.get(phase);
    if (!total) {
      total = emptyTotal();
      this.totals.set(phase, total);
    }
    total.ms += ms;
    total.count += count;

    const language = options?.language;
    if (language === undefined || language === "") return;
    let perPhase = this.perLanguage.get(phase);
    if (!perPhase) {
      perPhase = new Map();
      this.perLanguage.set(phase, perPhase);
    }
    let langTotal = perPhase.get(language);
    if (!langTotal) {
      langTotal = emptyTotal();
      perPhase.set(language, langTotal);
    }
    langTotal.ms += ms;
    langTotal.count += count;
  }

  /** Units recorded for `phase` — what the periodic progress lines cadence on. */
  count(phase: CodegraphPhase): number {
    return this.totals.get(phase)?.count ?? 0;
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  /** Structured read-out. Copies, so a caller cannot mutate the accumulator. */
  snapshot(): CodegraphPhaseTimingsSnapshot {
    const phases = {} as Record<CodegraphPhase, CodegraphPhaseTotal>;
    const byLanguage = {} as Record<CodegraphPhase, Record<string, CodegraphPhaseTotal>>;
    for (const phase of CODEGRAPH_PHASES) {
      const total = this.totals.get(phase);
      phases[phase] = total ? { ms: total.ms, count: total.count } : emptyTotal();
      const perPhase = this.perLanguage.get(phase);
      const langs: Record<string, CodegraphPhaseTotal> = {};
      if (perPhase) {
        for (const [language, langTotal] of perPhase) {
          langs[language] = { ms: langTotal.ms, count: langTotal.count };
        }
      }
      byLanguage[phase] = langs;
    }
    return { elapsedMs: this.elapsedMs(), phases, byLanguage };
  }

  /**
   * Log-shaped read-out: unit counts named per phase (`files` vs `calls`) and
   * the language split nested rather than flattened, so the line stays
   * unambiguous to parse. `byLanguage` is dropped for a phase nothing
   * labelled — an empty object in every line is noise.
   */
  toSummary(): Record<string, unknown> {
    const snapshot = this.snapshot();
    const out: Record<string, unknown> = { elapsedMs: snapshot.elapsedMs };
    for (const phase of CODEGRAPH_PHASES) {
      const unit = PHASE_UNIT[phase];
      const total = snapshot.phases[phase];
      const entry: Record<string, unknown> = { ms: total.ms, [unit]: total.count };
      const langs = snapshot.byLanguage[phase];
      const languageNames = Object.keys(langs);
      if (languageNames.length > 0) {
        const rendered: Record<string, unknown> = {};
        for (const language of languageNames) {
          rendered[language] = { ms: langs[language].ms, [unit]: langs[language].count };
        }
        entry.byLanguage = rendered;
      }
      out[phase] = entry;
    }
    return out;
  }

  /**
   * One-line JSON for the DEBUG markers. Progress lines embed it as a STRING
   * rather than a nested object on purpose: `console.error` inspects objects
   * only two levels deep, which would render the language split as `[Object]`
   * — precisely the number the line exists to carry.
   */
  toJson(): string {
    return JSON.stringify(this.toSummary());
  }
}
