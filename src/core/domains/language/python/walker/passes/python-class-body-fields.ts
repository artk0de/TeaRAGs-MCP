/**
 * Manager and queryset attributes declared in a CLASS BODY (bd
 * tea-rags-mcp-xpl83, E3 increment 1).
 *
 * The existing field collectors read `self.<field> = …` inside a method, which
 * is where Python binds INSTANCE state. Django binds a model's manager in the
 * class body instead — `objects = ObjectTypeManager()` on `ObjectType`,
 * `objects = RestrictedQuerySet.as_manager()` on `NetBoxModel` — so nothing read
 * it and `<Model>.objects` was untyped on hop 1 of the chain fold: 141 of
 * netbox's 148 `chain` misses, every one of them resolving on the manager
 * class's OWN method once the receiver is typed.
 *
 * The BARE form is a LANGUAGE-level mechanism, not a framework one: the emit rule
 * is project-class EVIDENCE, and a project that binds no class-body attribute to
 * one of its own classes walks byte-identically whatever it depends on. Gating
 * that form on Django was measured and rejected — it cost polar, which declares
 * no Django and spells no `as_manager`, 8 real edges.
 *
 * The `as_manager` form IS a framework one and is gated on the declared
 * dependencies (bd tea-rags-mcp-w205u.1): the name in front of the verb is
 * evidence only because Django says that classmethod exposes the queryset's
 * members, so a project whose manifests name no `django` must not have the fact
 * emitted at all. `managerFactoryActive` carries the answer in — the vocabulary
 * composes it (`python/vocabulary/frameworks/`) and the walker asks.
 *
 * Attribution is to the INNERMOST enclosing class, and the field name is taken
 * verbatim — netbox uses `objects` on 37 models and `_objects_raw` on one, and
 * nothing here special-cases either spelling.
 *
 * Deliberately SILENT on the DOTTED form, `objects = models.Manager()`: the
 * receiver of the dot is a module and nothing here can say which one, so the
 * name would resolve external and make `chainType` DROP where the call
 * currently falls through to a later strategy. Absence keeps that path
 * byte-identical — the fold's stop-at-unknown-hop already produces an untyped
 * receiver, and `chainType` returns CONTINUE on one. A BARE `CharField()` that
 * no import bound and no class in the file declares is silent for the same
 * reason: there is no evidence at all behind the name.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { ImportRef } from "../../../../../contracts/types/codegraph.js";

/** Django's own QuerySet classmethod: `Q.as_manager()` exposes `Q`'s members. */
const MANAGER_FACTORY_VERB = "as_manager";

export interface PythonClassBodyFieldTypes {
  /** `shortClassName -> field -> typeName`, the per-file channel. */
  readonly byShortName: Record<string, Record<string, string>>;
  /** `<relPath>::<dotted class FQ> -> field -> typeName`, the run-global one. */
  readonly byClassKey: Record<string, Record<string, string>>;
}

/**
 * The names this file can vouch for as PROJECT classes.
 *
 * `declared` is every `class X` in the file at any nesting depth, by short name —
 * the strongest evidence a per-file pass can hold. `importBound` is every local
 * name an import statement bound; in isolation it cannot tell
 * `netbox.models.querysets` from `django.db.models`, but the pipeline is not the
 * walker in isolation. The fact is emitted as a NAME, and the resolve-time
 * consumer (`resolveTypeFile` inside `pythonInheritedMemberType`) refuses a name
 * that maps outside the project — so a bare construction takes
 * `declared ∪ importBound` and the mapper still has to place it (bd
 * tea-rags-mcp-w205u, E4.6c). `as_manager` accepts the same union, where
 * Django's own verb rather than the name carries the claim.
 */
interface PythonClassNameEvidence {
  readonly declared: ReadonlySet<string>;
  readonly importBound: ReadonlySet<string>;
}

function collectDeclaredClassNames(root: AstNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: AstNode): void => {
    if (node.type === "class_definition") {
      const name = node.childForFieldName("name");
      if (name) names.add(name.text);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return names;
}

function collectImportBoundNames(imports: readonly ImportRef[]): Set<string> {
  const names = new Set<string>();
  for (const imp of imports) {
    for (const local of Object.keys(imp.importedBindings ?? {})) names.add(local);
  }
  return names;
}

/**
 * `<Name>()` | `<Name>.as_manager()` read off ONE class-body assignment node, or
 * `undefined` for anything else.
 *
 * The evidence differs per form. A plain construction has no verb, so the NAME
 * carries the whole claim and must be a class this file declares — which is what
 * declines `CharField()` and, being dotted rather than bare, `models.Manager()`.
 * `as_manager` is Django's own spelling, so an import binding is enough evidence
 * in front of it.
 *
 * An ANNOTATED class attribute (`objects: Manager = …`) is left to the
 * annotation facet, which owns every annotation channel and merges beneath the
 * monolith — reading it here would silently outrank the declared type.
 */
function pythonClassBodyFieldType(
  node: AstNode,
  evidence: PythonClassNameEvidence,
  managerFactoryActive: boolean,
): { readonly field: string; readonly type: string } | undefined {
  if (node.type !== "assignment") return undefined;
  if (node.childForFieldName("type")) return undefined;
  const left = node.childForFieldName("left");
  if (left?.type !== "identifier") return undefined;
  const right = node.childForFieldName("right");
  if (right?.type !== "call") return undefined;
  const callee = right.childForFieldName("function");
  if (!callee) return undefined;

  if (callee.type === "attribute") {
    // Django's verb, and only where Django is declared (bd tea-rags-mcp-w205u.1).
    if (!managerFactoryActive) return undefined;
    const verb = callee.childForFieldName("attribute");
    const object = callee.childForFieldName("object");
    if (verb?.text !== MANAGER_FACTORY_VERB || object?.type !== "identifier") return undefined;
    const name = object.text;
    if (!evidence.declared.has(name) && !evidence.importBound.has(name)) return undefined;
    return { field: left.text, type: name };
  }

  if (callee.type !== "identifier") return undefined;
  if (!evidence.declared.has(callee.text) && !evidence.importBound.has(callee.text)) return undefined;
  return { field: left.text, type: callee.text };
}

/**
 * Both field channels from ONE pass over the class bodies (the colocation rule:
 * every field of a structure populated in one place), so the per-file and
 * run-global maps can never disagree about nesting.
 *
 * Scope is tracked through EVERY named container, exactly as
 * `collectPythonClassFieldTypesByClassKey` spells it, so a class inside a `def`
 * keys as `build.Local`. Unlike that collector this one does NOT descend into a
 * function body for facts: an assignment there binds a local, not class state.
 */
export function collectPythonClassBodyFieldTypes(
  root: AstNode,
  relPath: string,
  imports: readonly ImportRef[],
  managerFactoryActive: boolean,
): PythonClassBodyFieldTypes {
  const evidence: PythonClassNameEvidence = {
    declared: collectDeclaredClassNames(root),
    importBound: collectImportBoundNames(imports),
  };
  const byShortName: Record<string, Record<string, string>> = {};
  const byClassKey: Record<string, Record<string, string>> = {};

  const visit = (node: AstNode, scope: readonly string[]): void => {
    const isContainer = node.type === "class_definition" || node.type === "function_definition";
    const nameNode = isContainer ? node.childForFieldName("name") : null;
    if (!nameNode) {
      for (const child of node.children) visit(child, scope);
      return;
    }
    const childScope = [...scope, nameNode.text];
    const body = node.childForFieldName("body");
    if (!body) return;
    if (node.type === "class_definition") {
      // DIRECT statements of this class body only — an assignment nested in a
      // method or a comprehension is not class state.
      for (const stmt of body.children) {
        if (stmt.type !== "expression_statement") continue;
        for (const child of stmt.children) {
          const found = pythonClassBodyFieldType(child, evidence, managerFactoryActive);
          if (found === undefined) continue;
          const short = nameNode.text;
          byShortName[short] = { ...(byShortName[short] ?? {}), [found.field]: found.type };
          const key = `${relPath}::${childScope.join(".")}`;
          byClassKey[key] = { ...(byClassKey[key] ?? {}), [found.field]: found.type };
        }
      }
    }
    for (const child of body.children) visit(child, childScope);
  };
  visit(root, []);

  return { byShortName, byClassKey };
}
