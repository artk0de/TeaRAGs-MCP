/**
 * Replay a project registry `tuning` snapshot into an env map with
 * env > registry > code default precedence: a key already set to a non-empty
 * value in `target` wins; empty-string target values count as unset (matching
 * envWithFallback); empty-string snapshot values (hand-edited registry) are
 * skipped so they don't poison the env.
 *
 * Shared by `index-codebase` (worker env seeding via resolveRegistryEnv),
 * `prime` (process.env before parseAppConfig), and `tune` (process.env before
 * the benchmark script spawns).
 */
export function replayTuningEnv(
  tuning: Record<string, string> | undefined,
  target: NodeJS.ProcessEnv | Record<string, string>,
): void {
  for (const [key, value] of Object.entries(tuning ?? {})) {
    const current = target[key];
    if ((current === undefined || current === "") && value !== "") {
      target[key] = value;
    }
  }
}
