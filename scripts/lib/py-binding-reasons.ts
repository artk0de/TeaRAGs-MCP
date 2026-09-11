/**
 * WHY a bare-name residual receiver stays untyped (bd tea-rags-mcp-1v12o.1.1,
 * E5.0a).
 *
 * `py-receiver-binding.ts` says WHAT bound the name. This says what the chain
 * would have needed to KNOW, one sub-bucket per binding family, so each bucket
 * names a mechanism rather than a symptom. The vocabulary is flat and the
 * prefixes carry the family: `a*` for `assignCallProject`, `b*` for
 * `paramAnnotated`, `c*` for `unbound`, `d*` for the iteration / alias tail.
 *
 * Annotation verdicts are NOT reimplemented here — `pythonTypeRefFromText` and
 * `pythonNominalReceiverName` are the production policy, imported from the
 * walker pass, so "which annotation forms the facet drops" is answered by the
 * facet and not by a script's guess.
 */
import {
  PYTHON_CONTAINER_FIRST,
  PYTHON_CONTAINER_LAST,
  PYTHON_DECLINED_TYPE_NAMES,
  pythonNominalReceiverName,
  pythonTypeRefFromText,
} from "../../src/core/domains/language/python/walker/passes/python-type-annotation.js";
import { enclosingPythonDef, IMPLICIT_RECEIVERS, type PyBindingAttribution } from "./py-receiver-binding.js";

export const PY_BINDING_REASONS = [
  "a1AnnotationDropped",
  "a2TransitiveDepth1",
  "a2TransitiveDeeper",
  "a3MultiReturnDisagree",
  "a4ParamAttrReturn",
  "a5AwaitAsyncGen",
  "a6ClsSelfFactory",
  "a7NamesakeCallee",
  "a8CalleeUnresolved",
  "a8CalleeReceiverUntyped",
  "a9TypedNominal",
  "a9NoReturn",
  "a9LocalReturn",
  "a9Other",
  "b1StringForwardRef",
  "b2UnionMulti",
  "b3Protocol",
  "b4GenericContainer",
  "b5OpaqueCallable",
  "b6ImportAlias",
  "b7Namesake",
  "b8TypeVar",
  "b9External",
  "b10Resolvable",
  "c1ImplicitReceiver",
  "c2ModuleScopeCall",
  "c3Global",
  "c4Closure",
  "c5ImportedName",
  "c6Comprehension",
  "c7Other",
  "d1IterableContainerAnnotated",
  "d2IterableCallResult",
  "d3IterableUnknown",
  "d4UnpackCallResult",
  "d5UnpackOther",
  "d6WalrusCallProject",
  "d7WalrusOther",
  "d8AliasOfAnnotatedParam",
  "d9AliasOfSelfField",
  "d10AliasUnknown",
  "none",
] as const;
export type PyBindingReason = (typeof PY_BINDING_REASONS)[number];

/** One project `def`, as much of it as a reason needs. */
export interface PyDefFacts {
  relPath: string;
  line: number;
  returnAnnotation: string | null;
  isClassMethod: boolean;
  isAsync: boolean;
  hasYield: boolean;
  /** Every `return <expr>` in the def's own body, expression text only. */
  returnExprs: readonly string[];
}

/** Everything a reason needs from the corpus, behind a port the tests hand a literal. */
export interface PyReasonView {
  linesOf: (relPath: string) => readonly string[];
  /** Project `def`s declared under this short name, anywhere in the corpus. */
  defsNamed: (name: string) => readonly PyDefFacts[];
  /** Files declaring a class under this short name. Two or more is a namesake. */
  classFilesNamed: (name: string) => readonly string[];
  /** `import` / `from … import …` statement texts of a file. */
  importLinesOf: (relPath: string) => readonly string[];
  isProtocolClass: (name: string) => boolean;
  typeVarNames: (relPath: string) => ReadonlySet<string>;
  /** The class-body annotation of `self.<field>` for the class enclosing `callLine1`. */
  fieldAnnotationOf: (relPath: string, callLine1: number, field: string) => string | null;
}

const CLASS_NAME = /^[A-Z]\w*$/;
export const lastSeg = (s: string): string => s.trim().split(".").pop() ?? "";

/** The nominal receiver name the production facet reads off an annotation, or `null`. */
export function annotationNominal(text: string): string | null {
  const ref = pythonTypeRefFromText(text);
  if (ref === undefined) return null;
  return pythonNominalReceiverName(ref) ?? null;
}

/** Is this annotation a container / mapping generic — the form that flattens to `container`? */
export function isContainerAnnotation(text: string): boolean {
  const open = text.indexOf("[");
  if (open <= 0) return false;
  const base = lastSeg(text.slice(0, open));
  return PYTHON_CONTAINER_FIRST.has(base) || PYTHON_CONTAINER_LAST.has(base);
}

/** Does the caller's own import set name exactly one of these candidate files? */
export function importNarrowsToOne(
  callerFile: string,
  typeName: string,
  candidates: readonly string[],
  view: PyReasonView,
): boolean {
  const modules: string[] = [];
  for (const line of view.importLinesOf(callerFile)) {
    const from = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
    if (from !== null) {
      const names = from[2].replace(/[()]/g, "").split(",");
      if (names.some((n) => lastSeg(n.split(/\s+as\s+/)[0]).trim() === typeName)) {
        modules.push(from[1]);
      }
      continue;
    }
    const plain = /^\s*import\s+([\w.]+)/.exec(line);
    if (plain !== null && lastSeg(plain[1]) === typeName) modules.push(plain[1]);
  }
  if (modules.length === 0) return false;
  // A RELATIVE import resolves against the caller's own package, and stripping
  // the dots instead turns `from .client import get_client` into a suffix that
  // matches every `client.py` in the corpus. polar writes its intra-package
  // imports this way, so treating them as absolute loses the disambiguation
  // the caller actually wrote down.
  const dir = callerFile.includes("/") ? callerFile.slice(0, callerFile.lastIndexOf("/")) : "";
  const suffixes = modules.flatMap((m) => {
    const dots = /^\.+/.exec(m)?.[0].length ?? 0;
    const tailPath = m.slice(dots).split(".").filter(Boolean).join("/");
    if (dots === 0) return [`${tailPath}.py`, `${tailPath}/__init__.py`];
    const up = dir.split("/").slice(0, dir === "" ? 0 : -(dots - 1) || undefined);
    const base = [...up, tailPath].filter((s) => s !== "").join("/");
    return [`${base}.py`, `${base}/__init__.py`];
  });
  const hit = candidates.filter((c) => suffixes.some((s) => c === s || c.endsWith(`/${s}`)));
  return hit.length === 1;
}

/** The SHAPE of one `return` expression, as far as RF.2's five rules care. */
export function returnExprShape(raw: string): string {
  const t = raw.trim().replace(/^await\s+/, "");
  if (/\bif\b.*\belse\b/.test(t) || /\bor\b/.test(t)) return "cond";
  if (t === "self" || t === "cls") return "self";
  const ctor = /^([A-Za-z_][\w.]*)\s*\(/.exec(t);
  if (ctor !== null) {
    const head = lastSeg(ctor[1]);
    if (head === "cls") return "self";
    return CLASS_NAME.test(head) ? `ctor:${head}` : `call:${head}`;
  }
  if (/^self\.\w+$/.test(t)) return "selfAttr";
  if (/^[a-z_]\w*\.\w+$/.test(t)) return "paramAttr";
  if (/^[A-Za-z_]\w*$/.test(t)) return "local";
  return "other";
}

/**
 * Bucket A — the local is bound to a PROJECT call whose result stayed untyped.
 * The sub-bucket is the CALLEE's return situation, which is the fact the chain
 * was missing.
 *
 * `selfAttr` lands in `a4` rather than `a9` on purpose: RF.2 types `self.x`
 * only when the class ANNOTATES that field, and the un-annotated majority is
 * exactly what a4 is counting.
 */
export function reasonForCallResult(calleeText: string, view: PyReasonView): PyBindingReason {
  const segments = calleeText.split(".");
  const tail = lastSeg(calleeText);
  const head = segments[0];
  // `A.b(…)` — the CLASS picks which `b` is the callee. Reading the last
  // segment alone makes every classmethod factory look namesake-ambiguous,
  // because a method name is declared in dozens of files.
  if (segments.length > 1 && CLASS_NAME.test(head)) {
    const files = view.classFilesNamed(head);
    if (files.length >= 2) return "a7NamesakeCallee";
    const scoped = files.length === 1 ? view.defsNamed(tail).filter((d) => d.relPath === files[0]) : [];
    if (scoped.length === 1) return reasonForDefFacts(scoped[0], view);
  }
  // `obj.method(…)` on a VALUE. The callee cannot be picked until `obj`'s own
  // type is known, so the missing fact is one level up the same chain — not a
  // namesake and not an absent def. `self` / `cls` are the exception: the
  // enclosing class already names the callee.
  if (segments.length > 1 && !CLASS_NAME.test(head) && !IMPLICIT_RECEIVERS.has(head)) {
    return view.defsNamed(tail).length === 0 ? "a8CalleeUnresolved" : "a8CalleeReceiverUntyped";
  }
  if (segments.length === 1 && CLASS_NAME.test(tail)) {
    const files = view.classFilesNamed(tail);
    if (files.length >= 2) return "a7NamesakeCallee";
    if (files.length === 1) return "a9TypedNominal";
  }
  const defs = view.defsNamed(tail);
  if (defs.length === 0) return "a8CalleeUnresolved";
  // An INHERITED factory is declared once on the base and called through many
  // subclasses; when every candidate def reads the same way, the ambiguity is
  // not what stopped the chain.
  const verdicts = [...new Set(defs.map((d) => reasonForDefFacts(d, view)))];
  if (verdicts.length === 1) return verdicts[0];
  return new Set(defs.map((d) => d.relPath)).size > 1 ? "a7NamesakeCallee" : "a9Other";
}

/** One callee def's return situation — the fact the caller's chain was missing. */
function reasonForDefFacts(def: PyDefFacts, view: PyReasonView): PyBindingReason {
  if (def.returnAnnotation !== null) {
    const annotation = def.returnAnnotation;
    if (/\bSelf\b/.test(annotation)) return "a6ClsSelfFactory";
    const nominal = annotationNominal(annotation);
    if (nominal === null) return "a1AnnotationDropped";
    return view.classFilesNamed(nominal).length >= 2 ? "a7NamesakeCallee" : "a9TypedNominal";
  }
  if (def.hasYield) return "a5AwaitAsyncGen";
  if (def.returnExprs.length === 0) return "a9NoReturn";
  const shapes = [...new Set(def.returnExprs.map(returnExprShape))];
  if (shapes.length > 1) return "a3MultiReturnDisagree";
  const shape = shapes[0];
  if (shape === "cond") return "a3MultiReturnDisagree";
  if (shape === "selfAttr" || shape === "paramAttr") return "a4ParamAttrReturn";
  if (shape === "self") return def.isClassMethod ? "a6ClsSelfFactory" : "a9TypedNominal";
  if (shape === "local") return "a9LocalReturn";
  if (shape.startsWith("ctor:")) {
    return view.classFilesNamed(shape.slice(5)).length >= 2 ? "a7NamesakeCallee" : "a9TypedNominal";
  }
  if (shape.startsWith("call:")) {
    const inner = view.defsNamed(shape.slice(5));
    const typed = inner.some(
      (d) =>
        (d.returnAnnotation !== null && annotationNominal(d.returnAnnotation) !== null) ||
        d.returnExprs.some((e) => returnExprShape(e).startsWith("ctor:")),
    );
    return typed ? "a2TransitiveDepth1" : "a2TransitiveDeeper";
  }
  return "a9Other";
}

/**
 * The class name a call-result binding WOULD be keyed by, when the callee
 * determines one. `-> Self` on `Cls.factory(…)` names `Cls`, not the declaring
 * base — the substitution `pythonInheritedMemberType` performs.
 */
export function calleeReturnNominal(calleeText: string, view: PyReasonView): string | null {
  const segments = calleeText.split(".");
  const tail = lastSeg(calleeText);
  const head = segments[0];
  const dottedOnClass = segments.length > 1 && CLASS_NAME.test(head);
  if (segments.length === 1 && CLASS_NAME.test(tail)) return tail;
  const files = dottedOnClass ? view.classFilesNamed(head) : [];
  // A namesake RECEIVER class is already the failing key — the callee's own
  // return never gets asked for, so the head is the name to report.
  if (files.length >= 2) return head;
  const scoped = files.length === 1 ? view.defsNamed(tail).filter((d) => d.relPath === files[0]) : [];
  const candidates = scoped.length > 0 ? scoped : view.defsNamed(tail);
  if (candidates.length === 0) return null;
  // Candidates that DISAGREE name no type. Picking the first would report an
  // arbitrary file's answer as the run's, which is how `get_client` — declared
  // five times in polar with five different return types — reads as unique.
  const nominals = [...new Set(candidates.map((d) => defReturnNominal(d, dottedOnClass ? head : null)))];
  return nominals.length === 1 ? nominals[0] : null;
}

function defReturnNominal(def: PyDefFacts, selfName: string | null): string | null {
  if (def.returnAnnotation !== null) {
    if (/\bSelf\b/.test(def.returnAnnotation)) return selfName;
    return annotationNominal(def.returnAnnotation);
  }
  const ctor = def.returnExprs.map(returnExprShape).find((s) => s.startsWith("ctor:"));
  return ctor === undefined ? null : ctor.slice(5);
}

const aliasBound = (callerFile: string, name: string, view: PyReasonView): boolean =>
  view.importLinesOf(callerFile).some((l) => new RegExp(`\\bas\\s+${name}\\s*(?:,|\\)|$)`).test(l));

/** Bucket B — an annotation is present and the facet still hands back no receiver. */
export function reasonForAnnotatedParam(callerFile: string, annotation: string, view: PyReasonView): PyBindingReason {
  const t = annotation.trim();
  const isString = /^["']/.test(t);
  const open = t.indexOf("[");
  const base = open > 0 ? lastSeg(t.slice(0, open)) : lastSeg(t.replace(/["']/g, ""));
  if (view.typeVarNames(callerFile).has(base)) return "b8TypeVar";
  const nominal = annotationNominal(t);
  if (nominal === null) {
    if (isContainerAnnotation(t)) return "b4GenericContainer";
    if (base === "Callable" || base === "Literal" || PYTHON_DECLINED_TYPE_NAMES.has(base)) return "b5OpaqueCallable";
    if (t.includes("|") || /^(Union|Optional)\[/.test(t)) return "b2UnionMulti";
    return "b9External";
  }
  if (aliasBound(callerFile, nominal, view)) return "b6ImportAlias";
  if (view.isProtocolClass(nominal)) return "b3Protocol";
  const files = view.classFilesNamed(nominal);
  if (files.length === 0) return "b9External";
  if (files.length >= 2) return "b7Namesake";
  if (isString && files[0] !== callerFile) return "b1StringForwardRef";
  return "b10Resolvable";
}

/** Bucket C — no binding statement for the name anywhere the per-chunk view can see. */
export function reasonForUnbound(callerFile: string, name: string, view: PyReasonView): PyBindingReason {
  if (IMPLICIT_RECEIVERS.has(name)) return "c1ImplicitReceiver";
  const src = view.linesOf(callerFile);
  if (src.some((l) => new RegExp(`^\\s*global\\s+[\\w,\\s]*\\b${name}\\b`).test(l))) return "c3Global";
  const imports = view.importLinesOf(callerFile);
  if (imports.some((l) => new RegExp(`\\b${name}\\b`).test(l))) return "c5ImportedName";
  if (imports.some((l) => /import\s+\*/.test(l))) return "c5ImportedName";
  if (src.some((l) => new RegExp(`[[({][^\\])}]*\\bfor\\s+${name}\\b`).test(l))) return "c6Comprehension";
  if (src.some((l) => new RegExp(`^\\s+${name}\\s*(?::[^=]+)?=[^=]`).test(l))) return "c4Closure";
  if (src.some((l) => new RegExp(`\\bdef\\s+\\w+\\s*\\([^)]*\\b${name}\\b`).test(l))) return "c4Closure";
  return "c7Other";
}

/** Bucket D — the iteration / unpack / walrus / alias tail; each names ONE missing fact. */
export function reasonForTail(
  binding: string,
  detail: string,
  callerFile: string,
  callLine1: number,
  view: PyReasonView,
): PyBindingReason {
  const src = view.linesOf(callerFile);
  const def = enclosingPythonDef(src, callLine1);
  const annotationOf = (name: string): string | null =>
    def?.params.find((p) => p.name === name && p.annotated)?.annotation ?? null;
  if (binding === "loopTarget" || binding === "comprehension") {
    const t = detail.trim();
    const selfField = /^self\.(\w+)$/.exec(t);
    const annotation =
      selfField !== null
        ? view.fieldAnnotationOf(callerFile, callLine1, selfField[1])
        : /^[A-Za-z_]\w*$/.test(t)
          ? annotationOf(t)
          : null;
    if (annotation !== null && isContainerAnnotation(annotation)) return "d1IterableContainerAnnotated";
    if (/^[A-Za-z_][\w.]*\s*\(/.test(t)) return "d2IterableCallResult";
    return "d3IterableUnknown";
  }
  if (binding === "tupleUnpack") {
    return /=\s*[A-Za-z_][\w.]*\s*\(/.test(detail) ? "d4UnpackCallResult" : "d5UnpackOther";
  }
  if (binding === "walrus") {
    const rhs = /:=\s*([A-Za-z_][\w.]*)\s*\(/.exec(detail);
    if (rhs === null) return "d7WalrusOther";
    const head = lastSeg(rhs[1]);
    return view.defsNamed(head).length > 0 || view.classFilesNamed(head).length > 0
      ? "d6WalrusCallProject"
      : "d7WalrusOther";
  }
  const t = detail.replace(/^module:\s*/, "").trim();
  if (/^self\.\w+$/.test(t)) return "d9AliasOfSelfField";
  if (/^[A-Za-z_]\w*$/.test(t) && annotationOf(t) !== null) return "d8AliasOfAnnotatedParam";
  return "d10AliasUnknown";
}

/** The ONE reason for a classified row: the family decides which bucket answers. */
export function classifyBindingReason(
  row: { relPath: string; startLine: number; receiver: string | null },
  attribution: PyBindingAttribution,
  view: PyReasonView,
): PyBindingReason {
  const { binding, detail } = attribution;
  if (detail.startsWith("module: ")) return "c2ModuleScopeCall";
  if (binding === "assignCallProject" || binding === "assignCallExternal") return reasonForCallResult(detail, view);
  if (binding === "paramAnnotated") {
    const def = enclosingPythonDef(view.linesOf(row.relPath), row.startLine);
    const annotation = def?.params.find((p) => p.name === row.receiver)?.annotation ?? null;
    return annotation === null ? "b10Resolvable" : reasonForAnnotatedParam(row.relPath, annotation, view);
  }
  if (binding === "unbound") return reasonForUnbound(row.relPath, row.receiver ?? "", view);
  if (
    binding === "loopTarget" ||
    binding === "comprehension" ||
    binding === "tupleUnpack" ||
    binding === "walrus" ||
    binding === "assignAlias"
  ) {
    return reasonForTail(binding, detail, row.relPath, row.startLine, view);
  }
  return "none";
}
