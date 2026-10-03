/**
 * Deterministic git fixture for the EsGitAdapter ⇄ GitCliAdapter equivalence
 * suites (w2dlu T9/T10). Built with the REAL git CLI so the oracle side is
 * bit-for-bit what a production `GitCliAdapter` sees.
 *
 * Shape (7 commits, 2 authors, strictly increasing deterministic timestamps):
 *
 *   c1 initial  (Alice) src/app.ts (8 lines) + README.md; multi-line message
 *   c2 util     (Bob)   app.ts edit+append, src/util.ts, assets/logo.bin (binary)
 *   c3 rename   (Alice) git mv util.ts → helper.ts (pure rename) + README edit
 *   c4 feature  (Bob)   [branch feature] src/feature.ts + app.ts append
 *   c5 mainSide (Alice) [main] app.ts first-line edit — divergent from c4
 *   c6 merge    (Alice) merge feature → main (--no-ff, both sides touch app.ts)
 *   c7 head     (Bob)   app.ts middle edit, feature.ts edit, .mailmap (Bob→Robert)
 *
 * Plus src/untracked.ts written but never committed (blame-returns-[] pin).
 *
 * Repo-local config pins:
 * - `diff.algorithm=myers`: shields the CLI oracle from a user-global
 *   patience/histogram override — libgit2 (es-git) always diffs with Myers.
 * - `commit.gpgsign=false`: no signing prompts on machines with global signing.
 * `diff.renames` is deliberately NOT pinned: both adapters read the same
 * effective config (EsGitAdapter mirrors it), so equivalence holds either way;
 * the history suite exercises the `false` branch explicitly.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importGitHistory } from "../../../../../__helpers__/git-history-import.js";

export interface EquivalenceFixtureRepo {
  root: string;
  /** c1 — Alice, multi-line message, adds src/app.ts + README.md. */
  initialSha: string;
  /** c2 — Bob, edits app.ts, adds src/util.ts + binary assets/logo.bin. */
  utilSha: string;
  /** c3 — Alice, pure rename util.ts → helper.ts + README edit. */
  renameSha: string;
  /** c4 — Bob, tip of the divergent `feature` branch. */
  featureSha: string;
  /** c5 — Alice, main-side divergent edit. */
  mainSideSha: string;
  /** c6 — merge of `feature` into main (--no-ff). */
  mergeSha: string;
  /** c7 — Bob, current HEAD. */
  headSha: string;
}

const ALICE = { name: "Alice", email: "alice@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };

export function buildEquivalenceFixtureRepo(): EquivalenceFixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "es-git-equivalence-"));
  const t = (day: number): string => `2026-01-0${day}T00:00:00Z`;

  // The whole history in ONE fast-import (bd tea-rags-mcp-1r3e5) instead of
  // ~27 init/config/add/commit/checkout/merge/rev-parse spawns. Each commit's
  // author is also its committer, both dated t(n), as the CLI chain made them;
  // the merge's tree is the clean auto-merge `git merge` produced (main's
  // header edit + feature's appended L10 and src/feature.ts).
  const sha = importGitHistory(
    root,
    [
      // c1 — initial (Alice), multi-line commit message
      {
        label: "initial",
        message: "feat: initial app\n\nIntroduces the app skeleton.\nSecond body line.",
        author: ALICE,
        authorDate: t(1),
        writes: {
          "src/app.ts": "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n",
          "README.md": "# Fixture\n\nEquivalence corpus.\n",
        },
      },
      // c2 — util module + binary logo (Bob)
      {
        label: "util",
        message: "feat: util module + logo",
        author: BOB,
        authorDate: t(2),
        writes: {
          "src/app.ts": "L1\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\n",
          "src/util.ts": "u1\nu2\nu3\n",
          "assets/logo.bin": Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]),
        },
      },
      // c3 — pure rename + README edit (Alice)
      {
        label: "rename",
        message: "refactor: rename util to helper",
        author: ALICE,
        authorDate: t(3),
        renames: [["src/util.ts", "src/helper.ts"]],
        writes: { "README.md": "# Fixture\n\nEquivalence corpus.\nRenamed util to helper.\n" },
      },
      // c4 — divergent feature branch (Bob)
      {
        label: "feature",
        branch: "feature",
        message: "feat: feature branch work",
        author: BOB,
        authorDate: t(4),
        writes: {
          "src/feature.ts": "F1\nF2\n",
          "src/app.ts": "L1\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\nL10\n",
        },
      },
      // c5 — main-side divergent edit (Alice)
      {
        label: "mainSide",
        message: "improve: app header",
        author: ALICE,
        authorDate: t(5),
        writes: { "src/app.ts": "L1-alice\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\n" },
      },
      // c6 — merge feature into main (--no-ff); both sides touched src/app.ts
      {
        label: "merge",
        message: "Merge branch 'feature'\n\nBrings feature work into main.",
        merge: ["feature"],
        author: ALICE,
        authorDate: t(6),
        writes: {
          "src/app.ts": "L1-alice\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\nL10\n",
          "src/feature.ts": "F1\nF2\n",
        },
      },
      // c7 — HEAD (Bob): app.ts middle edit + feature.ts edit + .mailmap mapping Bob
      {
        label: "head",
        message: "fix: adjust line five\n\nTracked-by: TR-123",
        author: BOB,
        authorDate: t(7),
        writes: {
          "src/app.ts": "L1-alice\nL2\nL3\nL4-bob\nL5-fix\nL6\nL7\nL8\nL9\nL10\n",
          "src/feature.ts": "F1\nF2-fix\n",
          ".mailmap": "Robert Mapped <robert@example.com> <bob@example.com>\n",
        },
      },
    ],
    { config: { "commit.gpgsign": "false", "diff.algorithm": "myers" } },
  );
  const initialSha = sha.initial;
  const utilSha = sha.util;
  const renameSha = sha.rename;
  const featureSha = sha.feature;
  const mainSideSha = sha.mainSide;
  const mergeSha = sha.merge;
  const headSha = sha.head;

  // Untracked file — blame/oid lookups on it must yield []/null on BOTH adapters.
  writeFileSync(join(root, "src/untracked.ts"), "never committed\n");

  return { root, initialSha, utilSha, renameSha, featureSha, mainSideSha, mergeSha, headSha };
}
