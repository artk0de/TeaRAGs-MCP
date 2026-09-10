/**
 * Family attribution over an oracle row dump (bd tea-rags-mcp-w205u, E4.0.4).
 *
 * Same method as seam 5 decision 1 and E3 decision 1: bucket every row by the
 * MECHANISM that would have answered it. Counts are ROWS — a site in two
 * overlapping chunks is emitted twice, which is what every rate the oracle
 * prints is computed over.
 *
 * Two tiers, kept apart on purpose. Tier 1 is decidable from the dump row
 * alone; tier 2 needs the caller's source line and is therefore judgement with
 * a measurable miss rate. Mixing them would hide which counts are cheap.
 *
 * Exactly ONE family per row: {@link PY_RESIDUAL_FAMILIES} is a precedence
 * list, most specific first, and the first match wins. A row matching nothing
 * is `other`, which is REPORTED rather than hidden — the spec's bar is that it
 * stays under 10 % of the residual or the list is split further.
 *
 * The five families the spec's list does not name — `moduleAliasMember`,
 * `classObjectReceiver`, `callResultChainHead`, `containerElementHop` and
 * `crossFileBareCall` — are exactly that split. Measured, they carry 373 polar
 * rows and 84 netbox rows; folding them back into `other` would put it at 36 %
 * of polar's residual and 71 % of netbox's, which is not a report.
 */

/** The dump-row fields attribution reads. A superset is fine; nothing else is touched. */
export interface PyResidualRow {
  relPath: string;
  startLine: number;
  callText: string;
  receiver: string | null;
  member: string;
  receiverKind: string;
  verdict: string;
  categories: readonly string[];
  oracleTargetRelPath: string | null;
  oracleTargetSymbolId: string | null;
}

/**
 * Everything tier 2 needs from the corpus, behind an interface so the
 * classifier stays pure and the unit tests hand it a literal. The report
 * script's implementation memoises one read per file.
 */
export interface PyResidualSourceView {
  /** Names this file's `import` / `from … import …` statements bind. */
  importBindings: (relPath: string) => ReadonlySet<string>;
  /**
   * The nearest assignment or annotation of `name` at or above `line`, source
   * text of that line, or `null` when the backwards scan found none. `null` is
   * counted: it is the classifier's own miss rate.
   */
  bindingLine: (relPath: string, line: number, name: string) => string | null;
  /** Names bound by a `TypeVar(` call in this file. */
  typeVarNames: (relPath: string) => ReadonlySet<string>;
  /** The enclosing `def`'s return annotation at `line`, `null` when it has none. */
  enclosingReturnAnnotation: (relPath: string, line: number) => string | null;
  /** The enclosing `def`'s parameter names at `line`. */
  enclosingDefParams: (relPath: string, line: number) => ReadonlySet<string>;
  /** Is this class name declared in-project with `Protocol` among its bases? */
  isProtocolClass: (className: string) => boolean;
  /** Is this name a project `@pytest.fixture` def? Always false without tests walked. */
  isProjectFixture: (name: string) => boolean;
}

export const PY_RESIDUAL_FAMILIES = [
  "runtimeOnly",
  "pytestFixture",
  "celeryEnqueue",
  "drfViewAttr",
  "djangoUrlRoute",
  "pydanticRow",
  "sqlalchemyRow",
  "superMro",
  "constructorChainHead",
  "callResultChainHead",
  "containerElementHop",
  "asyncForm",
  "moduleAliasMember",
  "transparentWrapper",
  "protocolReceiver",
  "unionBranchReceiver",
  "typeVarGeneric",
  "classObjectReceiver",
  "untypedFieldHop",
  "sameFileBareCall",
  "crossFileBareCall",
  "untypedNameReceiver",
  "other",
] as const;

export type PyResidualFamily = (typeof PY_RESIDUAL_FAMILIES)[number];

/** Which increment each family feeds. `OUT` means declared out of scope. */
export const PY_FAMILY_INCREMENT: Readonly<Record<PyResidualFamily, string>> = {
  runtimeOnly: "OUT",
  pytestFixture: "E4.3",
  celeryEnqueue: "E4.3",
  drfViewAttr: "E4.3",
  djangoUrlRoute: "E4.3",
  pydanticRow: "E4.2",
  sqlalchemyRow: "E4.2",
  superMro: "E4.4",
  constructorChainHead: "E4.6",
  callResultChainHead: "E4.6",
  containerElementHop: "E4.5",
  asyncForm: "E4.5",
  moduleAliasMember: "E4.6",
  transparentWrapper: "E4.2",
  protocolReceiver: "E4.1",
  unionBranchReceiver: "E4.1",
  typeVarGeneric: "E4.4",
  classObjectReceiver: "E4.4",
  untypedFieldHop: "E4.6",
  sameFileBareCall: "E4.6",
  crossFileBareCall: "E4.6",
  untypedNameReceiver: "E4.1",
  other: "—",
};

/** Tier 2 families — the ones whose count is a source read rather than a row read. */
export const PY_TIER2_FAMILIES: ReadonlySet<PyResidualFamily> = new Set<PyResidualFamily>([
  "moduleAliasMember",
  "transparentWrapper",
  "protocolReceiver",
  "unionBranchReceiver",
  "typeVarGeneric",
  "untypedFieldHop",
  "untypedNameReceiver",
  "pytestFixture",
]);

const WRAPPERS = ["Mapped", "Annotated", "ClassVar", "Final", "Required", "NotRequired", "InitVar"];
const SQLALCHEMY_RECEIVERS = new Set(["session", "self.session", "stmt", "statement", "query", "db", "self.db"]);
const SQLALCHEMY_MEMBERS = new Set(["execute", "scalars", "scalar_one", "scalar_one_or_none", "where", "join"]);
const PYDANTIC_MEMBERS = new Set([
  "model_validate",
  "model_validate_json",
  "model_dump",
  "model_dump_json",
  "model_copy",
  "model_construct",
]);
const CELERY_MEMBERS = new Set(["delay", "apply_async"]);
const DRF_MEMBERS = new Set(["get_serializer", "get_object", "get_queryset", "get_serializer_class"]);
const RUNTIME_HEADS = /^(getattr|setattr|hasattr|globals|locals|vars|eval|exec|__import__)\(/;
const CLASS_OBJECT_RECEIVERS = new Set(["cls", "self.__class__", "type(self)"]);

/** The receiver's head name — `self.repo.get` → `self`, `datatable` → `datatable`. */
export function receiverHead(receiver: string | null): string {
  if (receiver === null || receiver === "") return "";
  return receiver.split(/[.([\s]/, 1)[0] ?? "";
}

/** Does the receiver text end in a call — `Model(...)`, `get_client()`, `X[T](...)`? */
function receiverIsCall(receiver: string | null): boolean {
  return receiver !== null && /\)\s*$/.test(receiver) && receiver.includes("(");
}

/** The callee name of a receiver that is a call — `datatable.Datatable[T](…)` → `Datatable`. */
function callHeadName(receiver: string): string {
  const beforeArgs = receiver.slice(0, receiver.indexOf("("));
  const withoutSubscript = beforeArgs.replace(/\[[^\]]*\]\s*$/, "");
  const parts = withoutSubscript.split(".");
  return (parts[parts.length - 1] ?? "").trim();
}

/** Is the binding a union — PEP 604 `A | B`, `Optional[T]`, `Union[…]`, or a ternary? */
function isUnionBinding(text: string): boolean {
  if (/=\s*.+\bif\b.+\belse\b/.test(text)) return true;
  const annotation = /:\s*([^=#]+)/.exec(text);
  if (annotation === null) return false;
  return /\|\s*[A-Za-z_"]|Optional\[|Union\[/.test(annotation[1] ?? "");
}

/** The annotation's head name — `x: Mapped[int] = …` → `Mapped`, `x: pkg.Foo` → `Foo`. */
function annotationHead(text: string): string | null {
  const match = /:\s*"?([A-Za-z_][A-Za-z0-9_.]*)/.exec(text);
  if (match === null) return null;
  const parts = (match[1] ?? "").split(".");
  return parts[parts.length - 1] ?? null;
}

export interface PyFamilyAttribution {
  family: PyResidualFamily;
  /** 1 = decided from the row, 2 = decided from a source read. */
  tier: 1 | 2;
  /**
   * Did the backwards scan find a binding line for the receiver head? `false`
   * on a tier-2 candidate is the classifier's own miss and is reported as a
   * rate, not swallowed — a heuristic that cannot say so is not a measurement.
   */
  bindingFound: boolean;
}

/**
 * Attribute one residual row to exactly one family.
 *
 * Precedence runs framework-specific → shape-specific → untyped-residual, so a
 * `session.execute(select(X))` row is SQLAlchemy rather than "untyped name",
 * and `super().__init__()` is the MRO fold rather than a bare call. Reordering
 * this changes the counts D8 orders the program by, so it is pinned by tests.
 */
export function classifyResidualFamily(row: PyResidualRow, view: PyResidualSourceView): PyFamilyAttribution {
  const receiver = row.receiver ?? "";
  const head = receiverHead(row.receiver);
  const tier1 = (family: PyResidualFamily): PyFamilyAttribution => ({ family, tier: 1, bindingFound: true });

  if (RUNTIME_HEADS.test(row.callText) || row.member === "__getattr__" || row.member === "__call__") {
    return tier1("runtimeOnly");
  }
  if (head !== "" && view.isProjectFixture(head) && view.enclosingDefParams(row.relPath, row.startLine).has(head)) {
    return { family: "pytestFixture", tier: 2, bindingFound: true };
  }
  if (CELERY_MEMBERS.has(row.member)) return tier1("celeryEnqueue");
  if (DRF_MEMBERS.has(row.member) && head === "self") return tier1("drfViewAttr");
  if (receiver === "self.request" || row.callText.startsWith("self.request.")) return tier1("drfViewAttr");
  // `as_view` alone is NOT the route family: flask's own `View.as_view` is the
  // same class-attribute factory and 19 flask test rows landed here before the
  // gate was tightened to the urls module the registry actually lives in.
  if (/urls?\w*\.py$/.test(row.relPath) && (/^(path|re_path|url)\(/.test(row.callText) || row.member === "as_view")) {
    return tier1("djangoUrlRoute");
  }
  if (PYDANTIC_MEMBERS.has(row.member)) return tier1("pydanticRow");
  if (SQLALCHEMY_RECEIVERS.has(receiver) || row.callText.startsWith("select(")) return tier1("sqlalchemyRow");
  if (SQLALCHEMY_MEMBERS.has(row.member) && /^(select|stmt|statement|query)\b/.test(receiver)) {
    return tier1("sqlalchemyRow");
  }
  if (row.receiverKind === "super" || row.categories.includes("superMro")) return tier1("superMro");
  // The AWAITED receiver, not any `await` in the call text: `await x.m()` is an
  // ordinary call the walker already types, while `(await x).m()` is the form
  // E4.5 exists for. It runs ahead of the call-receiver test because an await
  // expression ends in `)` too.
  if (/(^|\W)await\s/.test(receiver) || row.callText.includes("asyncio.gather(")) return tier1("asyncForm");
  if (receiverIsCall(row.receiver)) {
    const callee = callHeadName(receiver);
    return tier1(/^[A-Z]/.test(callee) ? "constructorChainHead" : "callResultChainHead");
  }
  if (row.receiverKind === "index" || /\]\s*$/.test(receiver)) return tier1("containerElementHop");
  return classifyFromSource(row, view, head);
}

/**
 * Tier 2 — the families that cannot be seen in the row.
 *
 * `moduleAliasMember` runs FIRST because it is the only tier-2 test that is not
 * a binding read: a receiver head an `import` statement bound, on a receiver
 * the walker classified as a value rather than a class object, is a submodule
 * alias (polar's `from ..components import datatable`, netbox's `layout`). A
 * class imported the same way arrives as `receiverKind: "constant"`, which is
 * what keeps the two apart without resolving the import.
 */
function classifyFromSource(row: PyResidualRow, view: PyResidualSourceView, head: string): PyFamilyAttribution {
  const valueReceiver = row.receiverKind === "dynamic" || row.receiverKind === "localVar";
  if (head !== "" && valueReceiver && view.importBindings(row.relPath).has(head)) {
    return { family: "moduleAliasMember", tier: 2, bindingFound: true };
  }
  if (CLASS_OBJECT_RECEIVERS.has(receiver0(row)) || row.member === "cls" || row.receiverKind === "constant") {
    return { family: "classObjectReceiver", tier: 1, bindingFound: true };
  }
  // A DOTTED receiver is typed by its LAST segment, not by its head:
  // `self.payment_repo` is answered by `payment_repo`'s annotation and
  // `item.type` by `type`'s, which is where a `Mapped[T]` wrapper or a union
  // actually sits. Looking up the head instead attributes a field hop to
  // whatever the head happened to be annotated as (bd tea-rags-mcp-w205u).
  const bindingName = receiverTail(receiver0(row)) || head;
  const binding = bindingName === "" ? null : view.bindingLine(row.relPath, row.startLine, bindingName);
  if (binding !== null) {
    const annotated = annotationHead(binding);
    if (annotated !== null && WRAPPERS.includes(annotated)) {
      return { family: "transparentWrapper", tier: 2, bindingFound: true };
    }
    if (isUnionBinding(binding)) return { family: "unionBranchReceiver", tier: 2, bindingFound: true };
    if (annotated !== null && view.isProtocolClass(annotated)) {
      return { family: "protocolReceiver", tier: 2, bindingFound: true };
    }
    if (annotated !== null && view.typeVarNames(row.relPath).has(annotated)) {
      return { family: "typeVarGeneric", tier: 2, bindingFound: true };
    }
  }
  const returns = view.enclosingReturnAnnotation(row.relPath, row.startLine);
  if (returns !== null && (returns === "Self" || view.typeVarNames(row.relPath).has(returns))) {
    return { family: "typeVarGeneric", tier: 2, bindingFound: binding !== null };
  }
  if (row.receiverKind === "chain" || receiver0(row).includes(".")) {
    return { family: "untypedFieldHop", tier: 2, bindingFound: binding !== null };
  }
  if (row.receiverKind === "bareCall") {
    return row.oracleTargetRelPath === row.relPath
      ? { family: "sameFileBareCall", tier: 1, bindingFound: true }
      : { family: "crossFileBareCall", tier: 1, bindingFound: true };
  }
  if (valueReceiver || row.receiverKind === "selfMember") {
    return { family: "untypedNameReceiver", tier: 2, bindingFound: binding !== null };
  }
  return { family: "other", tier: 1, bindingFound: binding !== null };
}

/** The row's receiver text, `""` when the call is bare. */
function receiver0(row: PyResidualRow): string {
  return row.receiver ?? "";
}

/**
 * The last attribute segment of a dotted receiver — `self.payment_repo` →
 * `payment_repo`, `item.type` → `type` — and `""` for an undotted one, where
 * the head is already the name to look up.
 */
export function receiverTail(receiver: string): string {
  if (!receiver.includes(".")) return "";
  const parts = receiver.split(".");
  const tail = (parts[parts.length - 1] ?? "").trim();
  return /^[A-Za-z_]\w*$/.test(tail) ? tail : "";
}
