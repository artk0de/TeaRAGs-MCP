import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";

/**
 * Which collection footprints nothing uses any more, and how each one may be
 * removed. Pure over an inventory the caller reads — Qdrant collections and
 * aliases, registry entries, codegraph generations on disk, alias-keyed store
 * files — so `doctor` can show the verdict before anything is deleted and the
 * fix runs on exactly what was shown.
 *
 * Every finding carries its purge ACTION, and the action is where the
 * logical-vs-physical trap is closed: a stale generation of a project whose alias
 * is live is a `generation` action (removed by physical name, alias and stores
 * untouched); only a logical name nothing live answers to gets a `collection`
 * action, which runs the full cascade over every generation and store.
 */

/** Why a footprint counts as unused. */
export type FootprintFindingClass =
  /** Registry entry with an empty path, or whose project directory is gone. */
  | "dead-registration"
  /** Qdrant alias no registry entry claims. */
  | "unregistered-alias"
  /** Physical collection no alias points at and no registry entry or alias claims its base. */
  | "orphan-collection"
  /** `_vN` collection of a live alias that points at a different generation. */
  | "orphan-generation"
  /** Codegraph generation on disk with no Qdrant collection behind it. */
  | "orphan-codegraph"
  /** Alias-keyed store files (snapshot, stats, quarantine, …) of a collection that is gone. */
  | "store-leftover";

export type FootprintPurgeAction =
  /** Full cascade over the logical name; `registryEntry` is removed from the registry afterwards. */
  | { kind: "collection"; logicalName: string; path?: string; registryEntry?: string }
  /** One stale generation, by physical name; the alias and the alias-keyed stores stay. */
  | { kind: "generation"; logicalName: string; physicalName: PhysicalCollectionName };

export interface FootprintFinding {
  findingClass: FootprintFindingClass;
  logicalName: string;
  /** The Qdrant collection or codegraph generation the row is about; null for store-only leftovers. */
  physicalName: string | null;
  reason: string;
  /** Set when the fix must leave this finding alone, saying why. */
  blockedBy?: string;
  action: FootprintPurgeAction;
}

export interface FootprintRegistration {
  collectionName: string;
  name: string | null;
  path: string;
  /** Whether `path` is non-empty and exists on disk — read by the caller. */
  pathExists: boolean;
}

export interface FootprintInventory {
  physicalCollections: readonly PhysicalCollectionName[];
  aliases: readonly { aliasName: string; collectionName: string }[];
  registrations: readonly FootprintRegistration[];
  /** Physical names with a codegraph database or input spill on disk. */
  codegraphGenerations: readonly PhysicalCollectionName[];
  /** Logical names owning at least one alias-keyed store file. */
  storeLogicals: readonly string[];
  /** Logical or physical name → what proves it is in use right now. */
  inUse: ReadonlyMap<string, string>;
}

const GENERATION_SUFFIX = /_v\d+$/;

function baseOf(physicalName: string): string {
  return physicalName.replace(GENERATION_SUFFIX, "");
}

export function classifyCollectionFootprints(inventory: FootprintInventory): FootprintFinding[] {
  const aliasTargetByLogical = new Map(inventory.aliases.map((a) => [a.aliasName, a.collectionName]));
  const aliasTargets = new Set<string>(aliasTargetByLogical.values());
  const registrationByLogical = new Map(inventory.registrations.map((r) => [r.collectionName, r]));
  const livePhysicals = new Set<string>(inventory.physicalCollections);
  const findings: FootprintFinding[] = [];
  /** Logical names a finding already accounts for as a whole collection. */
  const claimedLogicals = new Set<string>();

  for (const registration of inventory.registrations) {
    if (registration.pathExists) continue;
    const logicalName = registration.collectionName;
    claimedLogicals.add(logicalName);
    findings.push({
      findingClass: "dead-registration",
      logicalName,
      physicalName: aliasTargetByLogical.get(logicalName) ?? (livePhysicals.has(logicalName) ? logicalName : null),
      reason:
        registration.path.length === 0
          ? "registry entry has no project path"
          : `project directory ${registration.path} is gone`,
      ...(registration.name !== null
        ? {
            blockedBy: `named '${registration.name}' — re-register it to adopt, or 'tea-rags projects unregister --name ${registration.name} --purge'`,
          }
        : {}),
      action: {
        kind: "collection",
        logicalName,
        ...(registration.path.length > 0 ? { path: registration.path } : {}),
        registryEntry: logicalName,
      },
    });
  }

  for (const { aliasName, collectionName } of inventory.aliases) {
    if (registrationByLogical.has(aliasName)) continue;
    claimedLogicals.add(aliasName);
    findings.push({
      findingClass: "unregistered-alias",
      logicalName: aliasName,
      physicalName: collectionName,
      reason: "alias has no registry entry",
      action: { kind: "collection", logicalName: aliasName },
    });
  }

  /** A base name something live still answers to: registered, or aliased. */
  const isLiveBase = (base: string): boolean =>
    !claimedLogicals.has(base) && (registrationByLogical.has(base) || aliasTargetByLogical.has(base));

  for (const physicalName of inventory.physicalCollections) {
    if (aliasTargets.has(physicalName) || registrationByLogical.has(physicalName)) continue;
    const logicalName = baseOf(physicalName);
    if (claimedLogicals.has(logicalName)) continue;
    if (isLiveBase(logicalName)) {
      const target = aliasTargetByLogical.get(logicalName);
      findings.push({
        findingClass: "orphan-generation",
        logicalName,
        physicalName,
        reason: target ? `alias '${logicalName}' points at ${target}` : `'${logicalName}' is not aliased to it`,
        action: { kind: "generation", logicalName, physicalName },
      });
      continue;
    }
    claimedLogicals.add(logicalName);
    findings.push({
      findingClass: "orphan-collection",
      logicalName,
      physicalName,
      reason: "no alias points at it and no registry entry claims it",
      action: { kind: "collection", logicalName },
    });
  }

  for (const physicalName of inventory.codegraphGenerations) {
    if (livePhysicals.has(physicalName) || aliasTargets.has(physicalName)) continue;
    const logicalName = baseOf(physicalName);
    if (isLiveBase(logicalName)) {
      findings.push({
        findingClass: "orphan-codegraph",
        logicalName,
        physicalName,
        reason: "codegraph generation with no Qdrant collection behind it",
        ...(physicalName === logicalName
          ? { blockedBy: "unversioned database of a live collection — not addressable as a generation" }
          : {}),
        action: { kind: "generation", logicalName, physicalName },
      });
      continue;
    }
    if (claimedLogicals.has(logicalName)) continue;
    claimedLogicals.add(logicalName);
    findings.push({
      findingClass: "orphan-codegraph",
      logicalName,
      physicalName,
      reason: "codegraph generation with no Qdrant collection or registry entry behind it",
      action: { kind: "collection", logicalName },
    });
  }

  for (const logicalName of inventory.storeLogicals) {
    if (claimedLogicals.has(logicalName) || isLiveBase(logicalName)) continue;
    if (inventory.physicalCollections.some((p) => baseOf(p) === logicalName)) continue;
    claimedLogicals.add(logicalName);
    findings.push({
      findingClass: "store-leftover",
      logicalName,
      physicalName: null,
      reason: "store files of a collection that no longer exists",
      action: { kind: "collection", logicalName },
    });
  }

  for (const finding of findings) {
    const live = registrationByLogical.get(finding.action.logicalName)?.pathExists === true;
    if (finding.action.kind === "collection" && live) {
      throw new Error(`census planned a collection purge of live '${finding.action.logicalName}'`);
    }
    const inUse =
      inventory.inUse.get(finding.logicalName) ??
      (finding.physicalName !== null ? inventory.inUse.get(finding.physicalName) : undefined);
    if (inUse !== undefined && finding.blockedBy === undefined) finding.blockedBy = `in use: ${inUse}`;
  }
  return findings;
}
