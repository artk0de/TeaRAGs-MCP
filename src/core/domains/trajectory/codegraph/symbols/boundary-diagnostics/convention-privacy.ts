import type { HierarchyView, NonPublicMemberEdge, RelPath } from "../../../../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import { MapHierarchyView } from "../../hierarchy-view.js";
import type {
  ConventionPrivacyOptions,
  ConventionPrivacyReport,
  ConventionPrivacyRule,
  ConventionPrivacyViolation,
  StableDependenciesScope,
} from "./types.js";

/**
 * Languages whose member privacy is a CONVENTION the compiler does not enforce,
 * and the rule each is judged by. The single source: the candidate read
 * (`GraphDbClient#readNonPublicMemberEdges`) is asked for exactly these.
 */
export const CONVENTION_PRIVACY_LANGUAGES: ReadonlySet<string> = new Set(["python", "ruby"]);

/**
 * `send` / `public_send` / `__send__` with a literal symbol or string first
 * argument, capturing the named method. The Ruby walker unwraps such a call
 * into a direct edge to that method and keeps the `send` call as the edge's
 * `callExpression` (`call-collection.ts`, `emitDynamicSendUnwrap`), which is
 * the only place the edge still says it came through `send`.
 */
const RUBY_SEND_LITERAL = /(?:^|[^\w])(?:public_send|__send__|send)\s*\(?\s*(?::|["'])([A-Za-z_]\w*[?!=]?)/g;

/**
 * Convention-privacy leaks (A4b, bd tea-rags-mcp-r8hme.1): members a language
 * marks private only by convention, reached from where the convention says
 * they must not be.
 *
 * - `python-underscore` — the target's short name starts with `_` and is not a
 *   dunder (`__x__`), and the source file sits in another package directory
 *   than the target's declaring file — unless a subclass reaches a member it
 *   inherited through `self` / `cls` / `super()` (`classHierarchy` option).
 * - `ruby-send-private` — the target is declared `private` / `protected`, the
 *   edge's call is a `send` family call whose literal names the target, and
 *   the source symbol's class is not the target's class.
 *
 * `sourcePathPattern` scopes judged edges by source file, as the other
 * detectors do. Diagnosis, not prescription.
 */
export function detectConventionPrivacyLeaks(
  edges: readonly NonPublicMemberEdge[],
  options: ConventionPrivacyOptions = {},
): ConventionPrivacyReport {
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope: StableDependenciesScope | undefined =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeEdgeCount: 0 }
      : undefined;
  const classHierarchy = options.classHierarchy && new MapHierarchyView(options.classHierarchy);
  const violations: ConventionPrivacyViolation[] = [];
  for (const edge of edges) {
    if (scope && inScope && !inScope(edge.sourceRelPath)) {
      scope.outOfScopeEdgeCount++;
      continue;
    }
    const rule = conventionPrivacyRule(edge, classHierarchy);
    if (rule) {
      violations.push({
        sourceRelPath: edge.sourceRelPath,
        targetRelPath: edge.targetRelPath,
        sourceSymbolId: edge.sourceSymbolId,
        targetSymbolId: edge.targetSymbolId,
        rule,
      });
    }
  }
  violations.sort(
    (a, b) =>
      compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
      compareCodePoints(a.sourceSymbolId, b.sourceSymbolId) ||
      compareCodePoints(a.targetRelPath, b.targetRelPath) ||
      compareCodePoints(a.targetSymbolId, b.targetSymbolId),
  );
  const countRule = (rule: ConventionPrivacyRule) => violations.filter((v) => v.rule === rule).length;
  return {
    violations,
    summary: {
      candidateEdgeCount: edges.length,
      violationCount: violations.length,
      violationsByRule: {
        pythonUnderscore: countRule("python-underscore"),
        rubySendPrivate: countRule("ruby-send-private"),
      },
      ...(scope ? { scope } : {}),
    },
  };
}

function conventionPrivacyRule(
  edge: NonPublicMemberEdge,
  classHierarchy: HierarchyView | undefined,
): ConventionPrivacyRule | null {
  if (edge.targetLanguage === "python") {
    return isPythonConventionPrivate(edge.targetShortName) &&
      directoryOf(edge.sourceRelPath) !== directoryOf(edge.targetRelPath) &&
      !isPythonInheritedSelfAccess(edge, classHierarchy)
      ? "python-underscore"
      : null;
  }
  if (edge.targetLanguage === "ruby") {
    return (edge.targetVisibility === "private" || edge.targetVisibility === "protected") &&
      sendNamesTarget(edge.callExpression, edge.targetShortName) &&
      rubyOwnerOf(edge.sourceSymbolId) !== rubyOwnerOf(edge.targetSymbolId)
      ? "ruby-send-private"
      : null;
  }
  return null;
}

/** `_x` and `__x` are private by convention; a dunder `__x__` is protocol, not privacy. */
function isPythonConventionPrivate(shortName: string): boolean {
  if (shortName.length < 2 || !shortName.startsWith("_")) return false;
  return !(shortName.startsWith("__") && shortName.endsWith("__"));
}

/**
 * A subclass reaching a member it inherited (bd tea-rags-mcp-r8hme.41): the
 * call's receiver is `self`, `cls` or `super(...)` and names the target
 * directly, and the target's class is an ancestor of the caller's class in
 * the persisted hierarchy. `_x` is protected by convention, and a subclass is
 * inside that convention — live flask read `Flask#handle_exception` →
 * `App#_find_error_handler` as a leak. The Python analogue of the Ruby rule's
 * "from outside its class". A module-level `_function` has no class, so it is
 * never exempted.
 */
function isPythonInheritedSelfAccess(edge: NonPublicMemberEdge, classHierarchy: HierarchyView | undefined): boolean {
  if (classHierarchy === undefined) return false;
  const receiverMember = PYTHON_SELF_RECEIVER_MEMBER.exec(edge.callExpression)?.[1];
  if (receiverMember !== edge.targetShortName) return false;
  const targetClass = ownerClassOf(edge.targetSymbolId);
  const sourceClass = ownerClassOf(edge.sourceSymbolId);
  if (targetClass === undefined || sourceClass === undefined) return false;
  return classHierarchy
    .getAncestors(sourceClass, { transitive: true })
    .some((ancestor) => ancestor.ancestorSymbolId === targetClass || ancestor.ancestorFqName === targetClass);
}

/**
 * `self.<m>` / `cls.<m>` / `super().<m>` / `super(C, self).<m>` at the start
 * of the call text, capturing `<m>` — the receiver is the instance or class
 * itself, never an attribute reached through it (`self.app._m` captures `app`).
 */
const PYTHON_SELF_RECEIVER_MEMBER = /^\s*(?:self|cls|super\s*\([^()]*\))\s*\.\s*([A-Za-z_]\w*)/;

/**
 * The class a member symbol belongs to: the id before its member separator
 * (`A.B#m` / `A.m` → `A.B` / `A`); `undefined` for a top-level function, which
 * has none.
 */
function ownerClassOf(symbolId: string): string | undefined {
  const cut = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  return cut === -1 ? undefined : symbolId.slice(0, cut);
}

function sendNamesTarget(callExpression: string, targetShortName: string): boolean {
  for (const match of callExpression.matchAll(RUBY_SEND_LITERAL)) {
    if (match[1] === targetShortName) return true;
  }
  return false;
}

/**
 * The class a Ruby symbol belongs to: the id before its member separator
 * (`A::B#m` / `A::B.m` → `A::B`); a symbol with no member separator — a class
 * body or a top-level method — is its own owner.
 */
function rubyOwnerOf(symbolId: string): string {
  return ownerClassOf(symbolId) ?? symbolId;
}

function directoryOf(relPath: RelPath): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
