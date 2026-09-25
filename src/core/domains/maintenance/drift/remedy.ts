import type { RechunkFileSelector } from "../../../contracts/types/rechunk.js";
import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";
import { combineRechunkSelectors } from "./chunk-set-scope.js";

/** A whole-index enrichment recompute, narrowed by language or not. */
export interface IndexDriftRecompute {
  trajectories: ReadonlySet<string>;
  languages: ReadonlySet<string> | null;
}

/**
 * The single command a drift report should recommend, as a lattice:
 * `none < incremental < recompute < force`.
 *
 * Every axis contributes its own remedy and the report folds them, so a run
 * that mixes a payload-key drift with a walker bump still names ONE command
 * (spec decision 14) instead of leaving the reader to work out which of two
 * competing ones subsumes the other.
 *
 * `force` carries a `selector` when the chunk-set bumps behind it declared
 * which files they touched (bd tea-rags-mcp-j4oww): the command is then a
 * SCOPED force that re-chunks that selection in place. A scoped force re-walks
 * only its selection, so unlike the plain one it cannot subsume a whole-index
 * recompute — that survives as `then`, the one case a report names a second
 * step.
 */
export type IndexDriftRemedy =
  | { kind: "none" }
  | { kind: "incremental" }
  | ({ kind: "recompute" } & IndexDriftRecompute)
  | { kind: "force"; selector?: RechunkFileSelector; then?: IndexDriftRecompute };

const RANK: Record<IndexDriftRemedy["kind"], number> = {
  none: 0,
  incremental: 1,
  recompute: 2,
  force: 3,
};

/**
 * Maximum over the lattice. Recomputes union their trajectories; the
 * `--languages` narrowing survives only when every recompute named one —
 * a collection-wide finding (shared kernel, env) widens the whole command.
 * Scoped forces combine into the narrowest one selection covering all of them;
 * one unscoped force makes the whole fold the plain `--force`.
 */
export function foldIndexDriftRemedies(remedies: readonly IndexDriftRemedy[]): IndexDriftRemedy {
  let top: IndexDriftRemedy["kind"] = "none";
  const trajectories = new Set<string>();
  let languages: Set<string> | null = new Set<string>();
  let sawForce = false;
  let selector: RechunkFileSelector | undefined;
  for (const remedy of remedies) {
    if (RANK[remedy.kind] > RANK[top]) top = remedy.kind;
    if (remedy.kind === "force") {
      selector = sawForce ? combineOptional(selector, remedy.selector) : remedy.selector;
      sawForce = true;
      if (remedy.then) collectRecompute(remedy.then);
      continue;
    }
    if (remedy.kind !== "recompute") continue;
    collectRecompute(remedy);
  }
  const recompute: IndexDriftRecompute | undefined =
    trajectories.size > 0 ? { trajectories, languages: languages && languages.size > 0 ? languages : null } : undefined;
  if (top === "force") {
    if (!selector) return { kind: "force" };
    return { kind: "force", selector, ...(recompute ? { then: recompute } : {}) };
  }
  if (top === "recompute" && recompute) return { kind: "recompute", ...recompute };
  return top === "incremental" ? { kind: "incremental" } : { kind: "none" };

  function collectRecompute(remedy: IndexDriftRecompute): void {
    for (const trajectory of remedy.trajectories) trajectories.add(trajectory);
    if (remedy.languages === null) languages = null;
    else if (languages !== null) for (const language of remedy.languages) languages.add(language);
  }
}

/** Combine two force selectors, where an absent one means the whole collection. */
function combineOptional(
  a: RechunkFileSelector | undefined,
  b: RechunkFileSelector | undefined,
): RechunkFileSelector | undefined {
  if (!a || !b) return undefined;
  return combineRechunkSelectors(a, b);
}

/**
 * One exact command. `--project` is filled in when the alias is known; an
 * incremental run needs a target, so it keeps a visible placeholder when it is
 * not, while recompute / force fall back to the CLI's cwd resolution.
 *
 * The plain full reindex is deliberately NEVER narrowed by language: it builds
 * a new collection. A scoped force (`--force` plus file filters) re-chunks its
 * selection in place instead, so there `--languages` is safe and is the point.
 */
export function renderIndexDriftRemedy(remedy: IndexDriftRemedy, projectAlias?: string): string {
  const project = projectAlias ? ` --project ${projectAlias}` : "";
  switch (remedy.kind) {
    case "none":
      return "No action required.";
    case "incremental":
      return `Run: tea-rags index-codebase --project ${projectAlias ?? "<alias>"}`;
    case "force": {
      const run = `Run: tea-rags index-codebase${project} --force${remedy.selector ? renderRechunkFlags(remedy.selector) : ""}`;
      return remedy.then ? `${run}\nThen: ${renderRecomputeCommand(remedy.then, project)}` : run;
    }
    case "recompute":
      return `Run: ${renderRecomputeCommand(remedy, project)}`;
  }
}

function renderRecomputeCommand(recompute: IndexDriftRecompute, project: string): string {
  const scope = [...recompute.trajectories].sort().join(",");
  const languages = recompute.languages ? ` --languages ${[...recompute.languages].sort().join(",")}` : "";
  return `tea-rags index-codebase${project} --force-enrichments ${scope}${languages}`;
}

/** The CLI flags of a scoped force, in a stable order. */
export function renderRechunkFlags(selector: RechunkFileSelector): string {
  const flags: string[] = [];
  if (selector.testFile) flags.push(`--test-file ${selector.testFile}`);
  if (selector.pathPattern) flags.push(`--path-pattern ${shellQuote(selector.pathPattern)}`);
  if (selector.fileExtensions?.length) flags.push(`--file-extension ${[...selector.fileExtensions].join(",")}`);
  if (selector.languages?.length) flags.push(`--languages ${[...selector.languages].sort().join(",")}`);
  if (selector.files?.length) flags.push(`--files ${shellQuote([...selector.files].join(","))}`);
  return flags.length > 0 ? ` ${flags.join(" ")}` : "";
}

/** Single-quote anything a shell would expand or split; plain words stay bare. */
function shellQuote(value: string): string {
  return /^[\w./,:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What ONE newly declared payload key costs to repopulate — the single place
 * the attribution rule lives.
 *
 * An unattributed key is treated as chunker-owned: assuming it is cheap to
 * recompute would hand back a command that silently populates nothing. Payload
 * keys are language-agnostic, so the recompute is never narrowed by language.
 */
export function resolvePayloadKeyRemedy(
  key: string,
  ownerByKey: ReadonlyMap<string, PayloadKeyOwner>,
): IndexDriftRemedy {
  const owner = ownerByKey.get(key);
  if (!owner?.recomputable || owner.trajectory === undefined) return { kind: "force" };
  return { kind: "recompute", trajectories: new Set([owner.trajectory]), languages: null };
}
