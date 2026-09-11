import type { PayloadKeyOwner } from "../../../contracts/types/trajectory.js";

/**
 * The single command a drift report should recommend, as a lattice:
 * `none < incremental < recompute < force`.
 *
 * Every axis contributes its own remedy and the report folds them, so a run
 * that mixes a payload-key drift with a walker bump still names ONE command
 * (spec decision 14) instead of leaving the reader to work out which of two
 * competing ones subsumes the other.
 */
export type IndexDriftRemedy =
  | { kind: "none" }
  | { kind: "incremental" }
  | { kind: "recompute"; trajectories: ReadonlySet<string>; languages: ReadonlySet<string> | null }
  | { kind: "force" };

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
 */
export function foldIndexDriftRemedies(remedies: readonly IndexDriftRemedy[]): IndexDriftRemedy {
  let top: IndexDriftRemedy["kind"] = "none";
  const trajectories = new Set<string>();
  let languages: Set<string> | null = new Set<string>();
  for (const remedy of remedies) {
    if (RANK[remedy.kind] > RANK[top]) top = remedy.kind;
    if (remedy.kind !== "recompute") continue;
    for (const trajectory of remedy.trajectories) trajectories.add(trajectory);
    if (remedy.languages === null) languages = null;
    else if (languages !== null) for (const language of remedy.languages) languages.add(language);
  }
  if (top !== "recompute") return { kind: top };
  return {
    kind: "recompute",
    trajectories,
    languages: languages && languages.size > 0 ? languages : null,
  };
}

/**
 * One exact command. `--project` is filled in when the alias is known; an
 * incremental run needs a target, so it keeps a visible placeholder when it is
 * not, while recompute / force fall back to the CLI's cwd resolution.
 *
 * The full reindex is deliberately NEVER narrowed by language: it builds a new
 * collection and flips the alias, so `--force --languages ruby` would leave an
 * index containing only Ruby.
 */
export function renderIndexDriftRemedy(remedy: IndexDriftRemedy, projectAlias?: string): string {
  const project = projectAlias ? ` --project ${projectAlias}` : "";
  switch (remedy.kind) {
    case "none":
      return "No action required.";
    case "incremental":
      return `Run: tea-rags index-codebase --project ${projectAlias ?? "<alias>"}`;
    case "force":
      return `Run: tea-rags index-codebase${project} --force`;
    case "recompute": {
      const scope = [...remedy.trajectories].sort().join(",");
      const languages = remedy.languages ? ` --languages ${[...remedy.languages].sort().join(",")}` : "";
      return `Run: tea-rags index-codebase${project} --force-enrichments ${scope}${languages}`;
    }
  }
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
