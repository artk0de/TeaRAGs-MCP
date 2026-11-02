/**
 * The host's answer to "is a rustc driver on disk now?" (bd tea-rags-mcp-hjbow.9)
 * — the same discovery the call-site runner settles a codegraph run with
 * (`discoverRustcDriver` over the real host), so status, prime and the graph
 * notices agree with what the next recompute will find: a prebuilt binary or a
 * toolchain that builds one.
 *
 * The runner's host bindings hash the driver crate once, on the first probe;
 * every probe after that re-runs discovery, because a driver can appear at any
 * time while the server lives. A discovery that throws reads as "not found".
 */

import type { RustcDriverPresenceProbe } from "../../contracts/rustc-driver-status.js";
import { defaultRustcCallSiteRunnerDeps, type RustcCallSiteRunnerDeps } from "./callsite-runner.js";

export function createRustcDriverPresenceProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RustcDriverPresenceProbe {
  let discover: RustcCallSiteRunnerDeps["discover"] | undefined;
  return () => {
    try {
      discover ??= defaultRustcCallSiteRunnerDeps(env).discover;
      return discover() !== null;
    } catch {
      return false;
    }
  };
}
