/**
 * Replay a project registry env snapshot into an env map with the ONE general
 * precedence rule — `outer env > project registry env > code default` —
 * ALIAS-GROUP aware: a snapshot key is skipped when ANY spelling of its alias
 * family (canonical or deprecated — see REGISTRY_ENV_GROUPS) is already set
 * to a non-empty value in the ambient env or the target. Without the group
 * check, a canonical registry key (INGEST_PIPELINE_CONCURRENCY,
 * EMBEDDING_BASE_URL) would survive the later `{...registryEnv,
 * ...process.env}` merge and SHADOW an externally-passed deprecated alias
 * (EMBEDDING_CONCURRENCY, OLLAMA_URL) because envWithFallback prefers the
 * canonical spelling — the external override would silently lose.
 *
 * Empty-string values count as unset on both sides (matching envWithFallback):
 * an empty target/ambient value does not block replay, and empty snapshot
 * values (hand-edited registry) are skipped so they don't poison the env.
 * Snapshot keys outside every known group (written by a newer tea-rags)
 * degrade to same-key checks and replay verbatim.
 *
 * Shared by `index-codebase` (worker env seeding via resolveRegistryEnv, with
 * ambient process.env), `prime` (process.env before parseAppConfig), `tune`
 * (process.env before the benchmark script spawns), and the MCP server's
 * per-request `ProjectIngestFactory` (registry env over the fixed server env,
 * into a request-scoped map — never into process.env).
 */

import { REGISTRY_ENV_GROUPS } from "./env-groups.js";

/**
 * Every spelling that can shadow the given key: the UNION of all alias
 * families the key belongs to. A shared alias (CODE_BATCH_SIZE sits in both
 * the embedding-batch and qdrant-upsert families) replayed from a legacy
 * snapshot would affect both groups at once, so an external override in
 * either family conservatively blocks it.
 */
const GROUP_MEMBERS_BY_KEY: ReadonlyMap<string, readonly string[]> = (() => {
  const byKey = new Map<string, Set<string>>();
  for (const group of REGISTRY_ENV_GROUPS) {
    const members = [group.canonical, ...group.aliases];
    for (const member of members) {
      const union = byKey.get(member) ?? new Set<string>();
      for (const m of members) union.add(m);
      byKey.set(member, union);
    }
  }
  return new Map([...byKey].map(([key, union]) => [key, [...union]]));
})();

const isSet = (env: NodeJS.ProcessEnv | Record<string, string>, key: string): boolean => {
  const value = env[key];
  return value !== undefined && value !== "";
};

export function replayRegistryEnv(
  snapshot: Record<string, string> | undefined,
  target: NodeJS.ProcessEnv | Record<string, string>,
  ambient: NodeJS.ProcessEnv | Record<string, string> = target,
): void {
  for (const [key, value] of Object.entries(snapshot ?? {})) {
    if (value === "") continue;
    const members = GROUP_MEMBERS_BY_KEY.get(key) ?? [key];
    const shadowed = members.some((member) => isSet(ambient, member) || isSet(target, member));
    if (!shadowed) target[key] = value;
  }
}
