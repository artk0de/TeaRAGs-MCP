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
 *
 * "Outer env" is what the ambient env is ALLOWED to override, and that depends
 * on where it came from: a CLI invocation's env overrides everything, a
 * long-lived server's spawn env only the runtime groups of a project's own
 * stamp. `outerEnvForRegistryStamp` below draws that line; callers replay
 * against its result (tea-rags-mcp-o0qsw).
 */

import { REGISTRY_ENV_GROUPS, registryEnvGroupMembers } from "./env-groups.js";

const isSet = (env: NodeJS.ProcessEnv | Readonly<Record<string, string>>, key: string): boolean => {
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
    // A shared alias (CODE_BATCH_SIZE sits in both the embedding-batch and
    // qdrant-upsert families) replayed from a legacy snapshot would affect both
    // groups at once, so an external override in either family blocks it.
    const members = registryEnvGroupMembers(key);
    const shadowed = members.some((member) => isSet(ambient, member) || isSet(target, member));
    if (!shadowed) target[key] = value;
  }
}

/**
 * Where the env of the process doing a replay came from, which decides how far
 * it outranks a registered project's stamp (tea-rags-mcp-o0qsw).
 *
 * - `invocation` — set for ONE run: a shell export in front of
 *   `tea-rags index-codebase`, `prime`, `tune`. It is a deliberate override and
 *   beats the stamp for every group — the general rule above.
 * - `server` — the env a long-lived MCP server was spawned with. It is
 *   configured once for EVERY project the server serves (often in the MCP config
 *   of whichever project the client session opened), so it is each project's
 *   DEFAULT, not its override. It keeps outranking the stamp for `runtime`
 *   groups only — those decide how a run executes, never what it writes.
 */
export type AmbientEnvRole = "invocation" | "server";

/**
 * The part of `ambient` that `replayRegistryEnv` must treat as the OUTER env
 * when it replays `stamp` — a registered project's own snapshot, identity keys
 * included.
 *
 * An invocation env is returned whole. A server env loses every spelling of
 * each index-shaping group (`chunk-set`, `enrichment:*`) that the stamp pins to
 * a DIFFERENT value, so replay writes the stamped one instead. Without that, a
 * server spawned with `CODE_CHUNK_SIZE=2000` re-chunks a project stamped at
 * 4500 on its next incremental run, and the env drift axis — which resolves
 * the same way — reports a finding whose remedy, run from a shell, re-stamps
 * 4500 and can never clear it.
 *
 * A group the server sets to the stamped value is kept: nothing differs, and an
 * overlay that stays empty is what lets `ProjectIngestFactory` hand back the
 * process-wide facade. A group the stamp does not pin is kept too — there is no
 * index shape to stay consistent with. Whole groups go, not single keys: a
 * legacy stamp spelled `CODE_CHUNK_OVERLAP` must not lose to a canonical
 * `INGEST_CHUNK_OVERLAP` the parser prefers.
 *
 * Never mutates `ambient`, and returns `ambient` itself when nothing was
 * dropped — identity is how a caller tells a server env that overrides nothing
 * (the auto-update spawner then lets its child inherit as before).
 */
export function outerEnvForRegistryStamp(
  stamp: Readonly<Record<string, string>> | undefined,
  ambient: NodeJS.ProcessEnv | Record<string, string>,
  role: AmbientEnvRole,
): NodeJS.ProcessEnv | Record<string, string> {
  if (role === "invocation") return ambient;
  let outer: NodeJS.ProcessEnv | undefined;
  for (const group of REGISTRY_ENV_GROUPS) {
    if (group.consequence === "runtime") continue;
    const members = [group.canonical, ...group.aliases];
    const stamped = firstSetValue(stamp ?? {}, members);
    if (stamped === undefined) continue;
    const current = firstSetValue(ambient, members);
    if (current === undefined || current === stamped) continue;
    outer ??= { ...ambient };
    for (const member of members) delete outer[member];
  }
  return outer ?? ambient;
}

/** The value a group resolves to in `env` — first set spelling, canonical first, as the config parser reads it. */
function firstSetValue(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
  members: readonly string[],
): string | undefined {
  const spelling = members.find((member) => isSet(env, member));
  return spelling === undefined ? undefined : env[spelling];
}
