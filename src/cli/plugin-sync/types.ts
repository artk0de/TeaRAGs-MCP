/** The agent harnesses whose tea-rags plugins `tea-rags update` keeps current. */
export type PluginHarness = "claude" | "codex" | "cursor";

/** One `<harness-cli> …` invocation; `missing` = the CLI is not on PATH. */
export interface HarnessCliRunResult {
  code: number | null;
  stdout: string;
  missing: boolean;
  /** Captured by the spawning runner; a CLI that reports failures as text writes them here. */
  stderr?: string;
}

export interface HarnessCliRunOptions {
  /** Working directory of the run — a project-scope plugin command acts on the project it runs in. */
  cwd?: string;
}

export type HarnessCliRunner = (args: string[], options?: HarnessCliRunOptions) => Promise<HarnessCliRunResult>;

/**
 * Outcome of one harness's sync. `skipped` means nothing was attempted:
 * the CLI is absent, no tea-rags plugin is installed, or the marketplace is a
 * local developer checkout that already serves its own working tree.
 */
export interface PluginSyncReport {
  updated: { id: string; oldVersion: string; newVersion: string }[];
  failed: { id: string; reason: string }[];
  /** A marketplace-declared command awaits a person; `acceptWith` re-runs the step accepting it. */
  needsConfirmation: { id: string; command: string; sha256: string; acceptWith: string }[];
  /** Set when the marketplace was re-pointed to the client's release tag. */
  repinned?: { from: string; to: string };
  /**
   * The re-pin to `to` was refused: it would uninstall plugins installed with
   * project or local scope (`scopedIds`, each `<id> (<scope>)`). A background
   * run refuses for any such install; `tea-rags update` re-pins and reinstalls
   * them from their project, refusing only for one whose project it cannot name.
   */
  repinDeferred?: { to: string; scopedIds: string[] };
  skipped?: "cli-missing" | "none-installed" | "dev-marketplace";
}

export interface HarnessPluginSyncAdapter {
  readonly harness: PluginHarness;
  sync: () => Promise<PluginSyncReport>;
}

export interface HarnessPluginSyncEntry {
  harness: PluginHarness;
  report: PluginSyncReport;
}

export interface HarnessPluginSyncReport {
  harnesses: HarnessPluginSyncEntry[];
}

export function emptyPluginSyncReport(): PluginSyncReport {
  return { updated: [], failed: [], needsConfirmation: [] };
}
