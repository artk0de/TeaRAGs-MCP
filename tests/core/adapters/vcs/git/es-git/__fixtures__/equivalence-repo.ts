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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

interface FixtureAuthor {
  name: string;
  email: string;
}

function git(root: string, args: string[], author: FixtureAuthor, isoDate: string): string {
  return execFileSync(
    "git",
    ["-C", root, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, ...args],
    {
      encoding: "utf8",
      // Pin author/committer via env too: inside a `git commit` hook run
      // (pre-commit affected-tests) git exports GIT_AUTHOR_NAME/EMAIL of the
      // OUTER commit, which takes precedence over `-c user.name=` and would
      // collapse both fixture authors (Alice/Bob) onto the outer identity,
      // breaking the mailmap/ownership assertions. Same fix already applied
      // in churn-walk-thread.test.ts's `gitIn` helper.
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      },
    },
  ).trim();
}

export function buildEquivalenceFixtureRepo(): EquivalenceFixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "es-git-equivalence-"));
  const t = (day: number): string => `2026-01-0${day}T00:00:00Z`;
  const head = (): string => git(root, ["rev-parse", "HEAD"], ALICE, t(1));

  git(root, ["init", "-q", "-b", "main"], ALICE, t(1));
  git(root, ["config", "commit.gpgsign", "false"], ALICE, t(1));
  git(root, ["config", "diff.algorithm", "myers"], ALICE, t(1));

  // c1 — initial (Alice), multi-line commit message
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/app.ts"), "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n");
  writeFileSync(join(root, "README.md"), "# Fixture\n\nEquivalence corpus.\n");
  git(root, ["add", "."], ALICE, t(1));
  git(
    root,
    ["commit", "-q", "-m", "feat: initial app\n\nIntroduces the app skeleton.\nSecond body line."],
    ALICE,
    t(1),
  );
  const initialSha = head();

  // c2 — util module + binary logo (Bob)
  writeFileSync(join(root, "src/app.ts"), "L1\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\n");
  writeFileSync(join(root, "src/util.ts"), "u1\nu2\nu3\n");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets/logo.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]));
  git(root, ["add", "."], BOB, t(2));
  git(root, ["commit", "-q", "-m", "feat: util module + logo"], BOB, t(2));
  const utilSha = head();

  // c3 — pure rename + README edit (Alice)
  git(root, ["mv", "src/util.ts", "src/helper.ts"], ALICE, t(3));
  writeFileSync(join(root, "README.md"), "# Fixture\n\nEquivalence corpus.\nRenamed util to helper.\n");
  git(root, ["add", "."], ALICE, t(3));
  git(root, ["commit", "-q", "-m", "refactor: rename util to helper"], ALICE, t(3));
  const renameSha = head();

  // c4 — divergent feature branch (Bob)
  git(root, ["checkout", "-q", "-b", "feature"], BOB, t(4));
  writeFileSync(join(root, "src/feature.ts"), "F1\nF2\n");
  writeFileSync(join(root, "src/app.ts"), "L1\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\nL10\n");
  git(root, ["add", "."], BOB, t(4));
  git(root, ["commit", "-q", "-m", "feat: feature branch work"], BOB, t(4));
  const featureSha = head();

  // c5 — main-side divergent edit (Alice)
  git(root, ["checkout", "-q", "main"], ALICE, t(5));
  writeFileSync(join(root, "src/app.ts"), "L1-alice\nL2\nL3\nL4-bob\nL5\nL6\nL7\nL8\nL9\n");
  git(root, ["add", "."], ALICE, t(5));
  git(root, ["commit", "-q", "-m", "improve: app header"], ALICE, t(5));
  const mainSideSha = head();

  // c6 — merge feature into main; both sides touched src/app.ts
  git(
    root,
    ["merge", "-q", "--no-ff", "-m", "Merge branch 'feature'\n\nBrings feature work into main.", "feature"],
    ALICE,
    t(6),
  );
  const mergeSha = head();

  // c7 — HEAD (Bob): app.ts middle edit + feature.ts edit + .mailmap mapping Bob
  writeFileSync(join(root, "src/app.ts"), "L1-alice\nL2\nL3\nL4-bob\nL5-fix\nL6\nL7\nL8\nL9\nL10\n");
  writeFileSync(join(root, "src/feature.ts"), "F1\nF2-fix\n");
  writeFileSync(join(root, ".mailmap"), "Robert Mapped <robert@example.com> <bob@example.com>\n");
  git(root, ["add", "."], BOB, t(7));
  git(root, ["commit", "-q", "-m", "fix: adjust line five\n\nTracked-by: TR-123"], BOB, t(7));
  const headSha = head();

  // Untracked file — blame/oid lookups on it must yield []/null on BOTH adapters.
  writeFileSync(join(root, "src/untracked.ts"), "never committed\n");

  return { root, initialSha, utilSha, renameSha, featureSha, mainSideSha, mergeSha, headSha };
}
