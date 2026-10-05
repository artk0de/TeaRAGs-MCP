import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import { DEFAULT_SDP_MIN_CONNECTION_COUNT, DEFAULT_SDP_TOLERANCE } from "./stable-dependencies.js";
import type {
  ComponentDependency,
  ComponentGraph,
  ComponentStableDependenciesExclusionCounts,
  ComponentStableDependenciesOptions,
  ComponentStableDependenciesReport,
  ComponentStableDependencyRootCause,
  ComponentStableDependencyViolation,
  StableDependenciesScope,
} from "./types.js";

/** File edges carried as evidence on one component violation; `fileEdgeCount` keeps the total. */
export const COMPONENT_EVIDENCE_FILE_EDGE_LIMIT = 5;

/** Same meaning as the file-level detector's: beyond the tolerance by more than rounding. */
const INSTABILITY_DELTA_EPSILON = 1e-9;

/**
 * The composition roots the layer rule declares — `.claude/rules/domain-boundaries.md`,
 * "Composition roots": `bootstrap/` is the application composition root above
 * `api/` (parses config, builds AppContext, hands the wired `App` to cli/mcp),
 * `core/api/` is the core one (assembles deps from every layer below, wires
 * via DI). Paths are repo-relative, the form a component dir carries.
 *
 * DECLARED, never derived: membership is this list, and the layer rule is its
 * source of truth — no heuristic rediscovers it (bd tea-rags-mcp-r8hme.51,
 * design call on tea-rags-mcp-89k7k.9). Assembling unstable concretes IS the
 * root's job, so an SDP delta sourced from one is annotated
 * (`compositionRoot: true` on the violation) rather than left a blind finding;
 * the violation stays REPORTED — the annotation is triage data, never a
 * suppression, exactly the `foundationTerminal` spirit.
 */
export const DECLARED_COMPOSITION_ROOT_COMPONENTS: readonly string[] = ["src/bootstrap", "src/core/api"];

/** Whether a component dir is a declared composition root, or lives inside one. */
export function isDeclaredCompositionRoot(componentDir: string): boolean {
  return DECLARED_COMPOSITION_ROOT_COMPONENTS.some(
    (root) => componentDir === root || componentDir.startsWith(`${root}/`),
  );
}

/**
 * The entry surfaces the layer rule declares — `.claude/rules/domain-boundaries.md`,
 * layer diagram: `src/cli` (process entry; its commands are composition
 * actors over the api assembly barrel) and `src/mcp` (the tool surface over
 * `core/api/public`). Nothing imports either, so an entry component's
 * instability — and a diff-window delta on it — is placement, not defect: the
 * unstable end of the main sequence is where an entry BELONGS. Paths are
 * repo-relative, the form a component dir carries.
 *
 * DECLARED, never derived, the same rule as
 * `DECLARED_COMPOSITION_ROOT_COMPONENTS` above: membership is this list and
 * the layer rule is its source of truth — no heuristic rediscovers it (bd
 * tea-rags-mcp-zh3l0). Maintenance cost, accepted: a new top-level entry
 * surface (a second binary, a lambda handler) joins this list by hand or
 * stays unannotated. A mainSequence finding for one carries `entryPoint:
 * true` — annotated, still REPORTED, triage data never a suppression, exactly
 * the `foundationTerminal` / `compositionRoot` spirit.
 */
export const DECLARED_ENTRY_POINT_COMPONENTS: readonly string[] = ["src/cli", "src/mcp"];

/** Whether a component dir is a declared entry surface, or lives inside one. */
export function isDeclaredEntryPoint(componentDir: string): boolean {
  return DECLARED_ENTRY_POINT_COMPONENTS.some(
    (entrySurface) => componentDir === entrySurface || componentDir.startsWith(`${entrySurface}/`),
  );
}

/**
 * Stable Dependencies Principle on components (bd tea-rags-mcp-r8hme.7) — the
 * granularity Martin defined it for. File-level instability with Ca + Ce in
 * single digits swung by one edge; a component's counts pool its files.
 *
 * A component dependency is judged unless:
 *
 * 1. it is CONTAINMENT (`COMPONENT_CONTAINMENT_REASON`): the target is nested
 *    inside the source's directory. A parent depending on its own parts is
 *    composition — the file-level analogue is a module facade wiring its
 *    internals — and on the self-index these edges (`language/ruby →
 *    language/ruby/walker`, `explore → explore/strategies`) were 12 of the 24
 *    violations the partition produced before they were excluded (taxdome: 56
 *    of 323). The reverse
 *    direction, a nested component reaching up into its parent, is judged;
 * 2. either component's connection count is below `minConnectionCount`. The
 *    default is the file-level floor, `DEFAULT_SDP_MIN_CONNECTION_COUNT`: the
 *    ratio is the same arithmetic over distinct files, so the same binomial
 *    noise argument sets the same floor. Measured on the self-index, 3 / 5 / 8
 *    / 12 left 13 / 12 / 11 / 8 violations — the floor trims the tail, it does
 *    not decide the list.
 *
 * Coupling is counted over the whole graph; `sourcePathPattern` only decides
 * which dependencies are judged. File-level exclusions (self, unwalked,
 * intra-component, facade aggregation) come from the component graph and are
 * reported alongside. A dependency whose source is a declared composition root
 * is judged like any other — it is ANNOTATED, not excluded (see
 * {@link DECLARED_COMPOSITION_ROOT_COMPONENTS}).
 */
export function detectComponentStableDependencyViolations(
  componentGraph: ComponentGraph,
  options: ComponentStableDependenciesOptions = {},
): ComponentStableDependenciesReport {
  const tolerance = options.tolerance ?? DEFAULT_SDP_TOLERANCE;
  const minConnectionCount = options.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope: StableDependenciesScope | undefined =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeEdgeCount: 0 }
      : undefined;
  const excluded: ComponentStableDependenciesExclusionCounts = {
    ...componentGraph.excluded,
    containment: 0,
    lowConnectionCount: 0,
  };
  const violations: ComponentStableDependencyViolation[] = [];
  let judgedEdgeCount = 0;

  for (const dependency of componentGraph.dependencies) {
    const source = componentGraph.components.get(dependency.sourceComponent);
    const target = componentGraph.components.get(dependency.targetComponent);
    if (!source || !target) continue;
    if (scope && inScope && !dependency.fileEdges.some((e) => inScope(e.sourceRelPath))) {
      scope.outOfScopeEdgeCount++;
    } else if (dependency.directoryRelation === "descendant") {
      excluded.containment++;
    } else if (source.connectionCount < minConnectionCount || target.connectionCount < minConnectionCount) {
      excluded.lowConnectionCount++;
    } else {
      judgedEdgeCount++;
      const instabilityDelta = target.instability - source.instability;
      if (instabilityDelta > tolerance + INSTABILITY_DELTA_EPSILON) {
        violations.push({
          sourceComponent: source.componentDir,
          targetComponent: target.componentDir,
          sourceInstability: source.instability,
          targetInstability: target.instability,
          instabilityDelta,
          sourceAfferentCount: source.afferentCount,
          sourceEfferentCount: source.efferentCount,
          targetAfferentCount: target.afferentCount,
          targetEfferentCount: target.efferentCount,
          callWeight: dependency.callWeight,
          directoryRelation: dependency.directoryRelation,
          fileEdgeCount: dependency.fileEdges.length,
          fileEdges: evidenceFileEdges(dependency),
          // The root assembling unstable concretes is the root's job (see
          // DECLARED_COMPOSITION_ROOT_COMPONENTS): annotated, still reported.
          ...(isDeclaredCompositionRoot(source.componentDir) ? { compositionRoot: true as const } : {}),
        });
      }
    }
  }

  violations.sort(bySeverity);
  const components = [...componentGraph.components.values()];
  const moduleComponentCount = components.filter((c) => c.kind === "module").length;
  return {
    violations,
    rootCauses: groupRootCauses(violations, componentGraph.dependencies),
    summary: {
      tolerance,
      minConnectionCount,
      edgeCount: componentGraph.fileEdgeCount,
      componentCount: components.length,
      moduleComponentCount,
      directoryComponentCount: components.length - moduleComponentCount,
      componentEdgeCount: componentGraph.dependencies.length,
      judgedEdgeCount,
      violationCount: violations.length,
      excluded,
      ...(scope ? { scope } : {}),
    },
  };
}

/** Heaviest call weight first, then path; capped at {@link COMPONENT_EVIDENCE_FILE_EDGE_LIMIT}. */
function evidenceFileEdges(dependency: ComponentDependency): ComponentStableDependencyViolation["fileEdges"] {
  return [...dependency.fileEdges]
    .sort(
      (a, b) =>
        b.callWeight - a.callWeight ||
        compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
        compareCodePoints(a.targetRelPath, b.targetRelPath),
    )
    .slice(0, COMPONENT_EVIDENCE_FILE_EDGE_LIMIT)
    .map((e) => ({
      sourceRelPath: e.sourceRelPath,
      targetRelPath: e.targetRelPath,
      callWeight: e.callWeight,
      // The names are how an evidence reader tells the four callWeight-0
      // causes apart (bd tea-rags-mcp-89k7k.2); absent stays absent, never an
      // undefined-valued key.
      ...(e.importedExportNames ? { importedExportNames: e.importedExportNames } : {}),
      ...(e.reexportedExportNames ? { reexportedExportNames: e.reexportedExportNames } : {}),
    }));
}

function groupRootCauses(
  violations: readonly ComponentStableDependencyViolation[],
  dependencies: readonly ComponentDependency[],
): ComponentStableDependencyRootCause[] {
  const byTarget = new Map<string, ComponentStableDependencyViolation[]>();
  for (const v of violations) {
    const group = byTarget.get(v.targetComponent);
    if (group) group.push(v);
    else byTarget.set(v.targetComponent, [v]);
  }
  const dependsOn = new Set(dependencies.map((d) => `${d.sourceComponent}\u0000${d.targetComponent}`));
  const rootCauses: ComponentStableDependencyRootCause[] = [];
  for (const [targetComponent, group] of byTarget) {
    const sources = [...new Set(group.map((v) => v.sourceComponent))].sort(compareCodePoints);
    rootCauses.push({
      targetComponent,
      targetInstability: group[0].targetInstability,
      violationCount: group.length,
      maxInstabilityDelta: Math.max(...group.map((v) => v.instabilityDelta)),
      sources,
      cycleWithDependents: sources.some((s) => dependsOn.has(`${targetComponent}\u0000${s}`)),
    });
  }
  return rootCauses.sort(
    (a, b) =>
      b.violationCount - a.violationCount ||
      b.maxInstabilityDelta - a.maxInstabilityDelta ||
      compareCodePoints(a.targetComponent, b.targetComponent),
  );
}

function bySeverity(a: ComponentStableDependencyViolation, b: ComponentStableDependencyViolation): number {
  return (
    b.instabilityDelta - a.instabilityDelta ||
    b.callWeight - a.callWeight ||
    compareCodePoints(a.sourceComponent, b.sourceComponent) ||
    compareCodePoints(a.targetComponent, b.targetComponent)
  );
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
