/**
 * The prime flow's registry runtime — its composition fragment (k7kmu C3).
 *
 * `run-prime.ts` is a LEAF: it holds no runtime import of the api assembly
 * barrel (`core/api/index.js`), the direction
 * `tests/cli/composition-actor-import-direction.test.ts` pins. Before the
 * registry runtime left the CONTRACT barrel (k7kmu C3 — `api/public` re-exports
 * no domain runtime any more), the leaf reached `CollectionRegistry` and the
 * env/backend replay functions through it; those symbols now live on the
 * assembly surface only, so this module constructs them and the `prime`
 * command injects the bundle — the same 89k7k.9/nkstp playbook the
 * path→collection resolver already follows. Tests inject the same bundle.
 */

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import {
  CollectionRegistry,
  IndexFreshnessCheck,
  RegistryQdrantBackendUnresolvedError,
  replayableRegistryEnv,
  replayRegistryEnv,
  resolveDomainEnvCodeDefaults,
  resolveRegistryQdrantBackend,
} from "../../core/api/index.js";
import { resolveDataDir, type PrimeRegistryRuntime } from "./run-prime.js";

export function primeRegistryRuntime(): PrimeRegistryRuntime {
  return {
    openRegistry: () =>
      new CollectionRegistry(resolveDataDir(), {
        envCodeDefaults: () => resolveRegistryEnvCodeDefaults(resolveDomainEnvCodeDefaults()),
      }),
    createFreshness: () => new IndexFreshnessCheck(),
    // The entry's backend is `resolveRegistryQdrantBackend`'s call, not a local
    // reading of `qdrantUrl` — see `run-prime.ts`'s lookup docs (bd
    // tea-rags-mcp-lzynm). An entry that contradicts itself degrades to
    // discovery: prime never fails.
    externalQdrantUrlOf: (entry) => {
      try {
        const backend = resolveRegistryQdrantBackend(entry);
        return backend.kind === "external" ? backend.url : undefined;
      } catch (error) {
        if (error instanceof RegistryQdrantBackendUnresolvedError) return undefined;
        throw error;
      }
    },
    replayEntryEnv: (entry, env) => {
      replayRegistryEnv(replayableRegistryEnv(entry), env);
    },
  };
}
