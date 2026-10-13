import type { DiffDetectorFinding, DiffDetectorStatus } from "../../../../contracts/types/diff-detector-finding.js";
import type { DiffFamilyDetector } from "./diff-family-detector.js";
import { detectorStatus, withRenderedSubject } from "./shared.js";

/** The facade-contract family's verdict when no contract port was injected. */
const NO_CONTRACT_READER_REASON = "no contract reader";
/**
 * The whole-module import name (the `WHOLE_MODULE_EXPORT_NAME` precedent the
 * facade-leak classifier set): a consumer taking `*` re-imports whatever the
 * surface holds, so no single name drop can break it.
 */
const WHOLE_MODULE_EXPORT_NAME = "*";

/**
 * Facade-contract breaks: a changed file that IS a measured module's facade
 * stops re-exporting names indexed consumers outside the module still
 * import — the SUPPLY side of the export surface (the demand side, a new
 * deep import past a facade, is leakingAbstraction's). The tree's re-export
 * surface is the overlay's own recorded names; the pre-diff demand is the
 * indexed graph's. Judged only when the tree recorded a re-export surface
 * at all — "not recorded" must never read as "exports nothing" (the same
 * guard `classifyFacadeLeak`'s `facadeNamesRecorded` makes on the report
 * side). A consumer the diff also changes (`inChange` — the whole change,
 * past-cap files included, bd tea-rags-mcp-lxbrr) is skipped: its indexed row is
 * stale, the diff judges its own read. Absent contract port = built:false.
 */
export const facadeContractDetector: DiffFamilyDetector = {
  family: "facadeContract",
  judge: ({ scope, overlay, inChange, contract }) => {
    if (contract === undefined) {
      return {
        findings: [],
        status: Object.freeze({
          detector: "facadeContract",
          built: false,
          reason: NO_CONTRACT_READER_REASON,
          findingCount: 0,
        }) satisfies DiffDetectorStatus,
      };
    }
    const findings: DiffDetectorFinding[] = [];
    for (const relPath of scope.changedFiles) {
      const componentDir = contract.facadeComponentOf(relPath);
      if (componentDir === undefined) continue;
      const treeExposed = new Set<string>();
      let reexportsRecorded = false;
      for (const edge of overlay.edgesFrom(relPath)) {
        if (edge.reexportedExportNames === undefined) continue;
        reexportsRecorded = true;
        for (const name of edge.reexportedExportNames) treeExposed.add(name);
      }
      if (!reexportsRecorded) continue;
      const indexedSurface = contract.indexedSurfaceOf(relPath);
      if (indexedSurface === undefined || indexedSurface.length === 0) continue;
      const dropped = new Set(indexedSurface.filter((name) => !treeExposed.has(name)));
      if (dropped.size === 0) continue;

      const consumersByDroppedName = new Map<string, Set<string>>();
      for (const consumer of contract.indexedConsumersOf(relPath)) {
        if (inChange.has(consumer.source)) continue;
        if (consumer.importedNames === undefined) continue;
        if (consumer.importedNames.includes(WHOLE_MODULE_EXPORT_NAME)) continue;
        for (const name of consumer.importedNames) {
          if (!dropped.has(name)) continue;
          const sources = consumersByDroppedName.get(name);
          if (sources === undefined) consumersByDroppedName.set(name, new Set([consumer.source]));
          else sources.add(consumer.source);
        }
      }
      if (consumersByDroppedName.size === 0) continue;

      const droppedNames = [...consumersByDroppedName.keys()].sort();
      findings.push(
        withRenderedSubject({
          detector: "facadeContract",
          endpoints: { kind: "file", relPath, component: componentDir },
          evidence: {
            droppedNames: droppedNames.map((name) => ({
              name,
              consumers: [...(consumersByDroppedName.get(name) ?? [])].sort(),
            })),
          },
          detail:
            `the diff stops re-exporting names the module's consumers still import: ` +
            `${droppedNames.join(", ")} left ${relPath}'s re-export surface while indexed files outside ` +
            `${componentDir} still import them`,
        }),
      );
    }
    return { findings, status: detectorStatus("facadeContract", findings.length) };
  },
};
