/**
 * One hardware lease for every asker of a run — the residual pass and the
 * calibration it may trigger: the first `acquire` takes the provider's lease,
 * later ones reuse it, and only `release` gives it back.
 */
import type { ResidualProviderLease } from "../../../../contracts/types/codegraph-residual.js";
import type { ResidualModelProvider } from "./types.js";

export interface SharedProviderLease {
  provider: ResidualModelProvider;
  release: () => Promise<void>;
}

const KEPT: ResidualProviderLease = { release: async () => undefined };

export function shareProviderLease(provider: ResidualModelProvider): SharedProviderLease {
  const { acquire } = provider;
  if (acquire === undefined) return { provider, release: async () => undefined };
  let held: Promise<ResidualProviderLease> | undefined;
  const shared: ResidualModelProvider = {
    id: provider.id,
    threshold: provider.threshold,
    ...(provider.promptTemplate === undefined ? {} : { promptTemplate: provider.promptTemplate }),
    version: async () => provider.version(),
    health: async () => provider.health(),
    resolveGroup: async (group, signal) => provider.resolveGroup(group, signal),
    acquire: async () => {
      held ??= acquire.call(provider).catch((error: unknown) => {
        held = undefined;
        throw error;
      });
      await held;
      return KEPT;
    },
  };
  return {
    provider: shared,
    release: async () => {
      const lease = held;
      held = undefined;
      const taken = await lease?.catch(() => undefined);
      await taken?.release();
    },
  };
}
