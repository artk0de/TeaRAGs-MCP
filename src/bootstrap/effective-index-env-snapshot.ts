/**
 * buildEffectiveIndexEnvSnapshot — the read-side twin of the registry env
 * snapshot (`config/env-snapshot.ts`) that REPLAYS a stamp.
 *
 * It lives in the composition root, not beside the snapshot vocabulary in
 * `bootstrap/config`: replaying a stamp reads the registry domain and stating
 * the effective value of a pool-size knob reads the domains that own its
 * default, and the stable config component must reach neither (bd
 * tea-rags-mcp-umixb).
 */

import {
  outerEnvForRegistryStamp,
  replayRegistryEnv,
  resolveDomainEnvCodeDefaults,
  type AmbientEnvRole,
} from "../core/api/index.js";
import { isDebug } from "../core/primitives/diagnostics/index.js";
import { buildRunningIndexEnvSnapshot, parseAppConfigZod } from "./config/index.js";

/**
 * The canonical env snapshot the NEXT index run on `collectionName` would
 * produce, given the snapshot its last run stamped (`EnvDriftMonitor`, spec
 * decision 6).
 *
 * The same resolution `ProjectIngestFactory#forPath` performs before it builds
 * an ingest facade — outer env > stored registry env > code default, where a
 * `server` role narrows the outer env to what `outerEnvForRegistryStamp` lets
 * it override — expressed as a snapshot so it can be diffed against the stamp
 * key for key. It lives in bootstrap rather than in the monitor because `core/`
 * must not import `bootstrap/`. Replay writes onto a COPY of `ambient`;
 * `process.env` is never mutated.
 *
 * An unparseable result is no claim, not a throw. A stamp can carry a value the
 * current build no longer accepts (a retired enum member), and this runs on the
 * read path behind a search response, where a diagnostic must never fail the
 * query. It is not silent, though: a swallowed parse disables the whole env
 * axis for that collection, which is indistinguishable from "nothing drifted",
 * so the reason goes to the debug log under the collection's own name. The
 * stamp itself is not tolerated anywhere that matters — the next index run
 * parses the same env and refuses to start.
 */
export function buildEffectiveIndexEnvSnapshot(
  stored: Readonly<Record<string, string>>,
  collectionName: string,
  ambient: NodeJS.ProcessEnv = process.env,
  /**
   * Where `ambient` came from — the same role `ProjectIngestFactory` resolves a
   * real run with, or the axis reports what no run would do. A server's spawn
   * env yields every index-shaping group the stamp pins (tea-rags-mcp-o0qsw).
   */
  role: AmbientEnvRole = "invocation",
): Readonly<Record<string, string>> {
  try {
    const env: NodeJS.ProcessEnv = { ...outerEnvForRegistryStamp(stored, ambient, role) };
    replayRegistryEnv(stored, env);
    return buildRunningIndexEnvSnapshot(parseAppConfigZod(env), resolveDomainEnvCodeDefaults());
  } catch (error) {
    if (isDebug()) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[Drift] env axis skipped for ${collectionName}: its env stamp does not parse here — ${reason}`);
    }
    return {};
  }
}
