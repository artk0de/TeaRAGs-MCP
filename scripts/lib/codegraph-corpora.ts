/**
 * The E0 corpora manifest, typed (bd tea-rags-mcp-mmckn).
 *
 * Versioned HERE and not in `~/Dev/Tools/tea-rags-bench` because that directory
 * is not a versioned checkout: a baseline recorded there has no history and no
 * diff, and the whole point of the numbers is that a later run can be compared
 * against them. Paths carry `~` in the JSON so the manifest stays readable and
 * machine-independent; every consumer receives them expanded.
 *
 * This module reads the manifest and nothing else. It deliberately does NOT
 * check that a path exists: the loader is unit-tested on machines where the
 * corpora are absent, and a missing corpus must fail at the harness's own walk
 * with a message naming the corpus, not here with an ENOENT during a parse.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CodegraphCorpusBaseline {
  edges: number;
  fileOnly: number;
  unresolved: number;
  peakRssMb: number;
  wallSeconds: number;
}

export interface CodegraphCorpus {
  name: string;
  path: string;
  language: "python";
  sha?: string;
  requiresPython: string;
  venvPython: string;
  venvPythonVersion: string;
  roots: string[];
  stack: string[];
  baseline: CodegraphCorpusBaseline;
  notes?: string;
}

/** The manifest as it sits on disk — `name` is the key, not a field. */
type CodegraphCorpusEntry = Omit<CodegraphCorpus, "name">;

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "codegraph-corpora.json");

/**
 * Expand a leading `~/` to the current user's home. ONLY the leading segment:
 * `/tmp/~notahome` is a path a corpus could legitimately live under, and
 * silently rewriting it would be worse than not supporting `~` at all.
 */
export function expandHome(candidate: string): string {
  if (candidate === "~") return homedir();
  if (!candidate.startsWith("~/")) return candidate;
  return resolve(homedir(), candidate.slice(2));
}

let cached: Record<string, CodegraphCorpus> | null = null;

/** Every corpus, keyed by manifest name, paths expanded. Read once per process. */
export function loadCodegraphCorpora(): Record<string, CodegraphCorpus> {
  if (cached !== null) return cached;
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, CodegraphCorpusEntry>;
  const loaded: Record<string, CodegraphCorpus> = {};
  // Sorted so anything iterating the manifest — the baseline runner, the report
  // header — visits the corpora in one fixed order across machines.
  for (const name of Object.keys(raw).sort()) {
    const entry = raw[name];
    if (entry === undefined) continue;
    loaded[name] = {
      ...entry,
      name,
      path: expandHome(entry.path),
      venvPython: expandHome(entry.venvPython),
    };
  }
  cached = loaded;
  return loaded;
}

/** One corpus by name; throws naming the corpus and the known set. */
export function loadCodegraphCorpus(name: string): CodegraphCorpus {
  const corpora = loadCodegraphCorpora();
  const corpus = corpora[name];
  if (corpus === undefined) {
    throw new Error(`unknown corpus '${name}' (have: ${Object.keys(corpora).join(", ")})`);
  }
  return corpus;
}
