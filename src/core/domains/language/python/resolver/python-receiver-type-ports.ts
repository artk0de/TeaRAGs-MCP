/**
 * Python's four answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`, E1 seam 3, bd tea-rags-mcp-9fgdi).
 *
 * The channels are the ones Python already carries: `localBindings` for a
 * variable, `classFieldTypes` for `self.<attr>`, and `structuredReturnTypes`
 * for what a call yields — the last of which the annotation facet fills and
 * nothing read until this seam.
 *
 * The ports are built ONCE per resolver, not per call site: `ctx` is an
 * argument to every one of them, and the only thing the factory closes over is
 * the `PythonImportFileMapper` whose memo is keyed by symbol-table identity.
 * That mapper is why this is a factory rather than the frozen module-level
 * singleton the plan sketched — `resolveTypeFile` needs one, the resolver owns
 * exactly one so every consumer shares its resolved-root cache, and a private
 * one per module would both fragment the cache and diverge from what
 * `localBinding` / `importedName` ask the same question with.
 * Allocation stays at one object per resolver, which is what the perf budget
 * (`wall ≤ +25%` on netbox) actually cares about.
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import { isDerivedLocalBinding, type CallContext, type LocalBinding } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  splitAtBracketDepthZero,
  splitReceiverHops,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../kernel/index.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { pythonClassKey } from "./python-class-key.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { pythonDerivedBindingType, pythonElementTypeOf, pythonLocalBindingInForce } from "./python-iteration-types.js";
import { pythonOwnerIndependentMemberType, pythonPlacedBindingUnion } from "./python-member-return-types.js";
import {
  findPythonImportBinding,
  lastSegment,
  parsePythonClassKey,
  pythonAliasedClassKey,
  pythonBareCallReturnType,
  pythonEnclosingClass,
  pythonImportMatchesReceiver,
  pythonInheritedAttributeType,
  pythonInheritedMemberType,
  pythonModuleValueClass,
  pythonModuleValueClassIn,
  receiverModuleText,
  resolveTypeFile,
  type PythonMemberAccess,
} from "./strategies/shared.js";

export const PYTHON_CHAIN_MAX_HOPS_ENV = "CODEGRAPH_PY_CHAIN_MAX_HOPS";

/** A single capitalized identifier — Python's class-name convention, no `::`. */
const PYTHON_CLASS_HEAD = /^[A-Z]\w*$/;

/** A bare attribute link: one identifier, no call and no subscript. */
const PYTHON_BARE_ATTRIBUTE_LINK = /^[A-Za-z_]\w*$/;

/** The two modules that export `Self` and `cast`. */
const PYTHON_TYPING_MODULES: ReadonlySet<string> = new Set(["typing", "typing_extensions"]);

/**
 * `Datatable[Benefit, S]` → `Datatable`; `Datatable` → `Datatable`.
 *
 * Python generics ONLY, and deliberately not folded into the shared
 * `stripCallArgs`: in Ruby `xs[0].foo` is an index and `xs[0]` is what the fold
 * expects to see.
 */
function stripPythonSubscript(name: string): string {
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
}

/**
 * The FILE a module-alias head names — the composed module text first, then the
 * package alias when that text maps nowhere (bd tea-rags-mcp-w205u, E4.6b-1).
 *
 * The same two questions `importedName`'s module arm asks, asked here of a
 * chain HEAD. polar's `from ..components import datatable` composes
 * `..components.datatable`, which names no file; the package's
 * `from . import _datatable as datatable` is what says which module the head
 * denotes, and `resolveExportedModule` is deterministic on it.
 */
function pythonHeadModuleFile(head: string, ctx: CallContext, mapper: PythonImportFileMapper): string | null {
  const binding = findPythonImportBinding(ctx.imports, head);
  if (binding === null) return null;
  const composed = mapper.mapImportToFile(receiverModuleText(binding), ctx.callerFile, ctx);
  if (composed.kind === "project") return composed.relPath;
  const pkg = mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
  if (pkg.kind !== "project") return null;
  return mapper.resolveExportedModule(pkg.relPath, binding.importedName, ctx);
}

/**
 * Does the file a module-alias head names DECLARE `member` at top level, once?
 *
 * Exact-symbolId `lookup`, which only a top-level `def` / `class` carries as
 * its whole id — the same gate `moduleMemberTarget` uses, and never a
 * short-name search across the project.
 */
function pythonHeadModuleDeclares(
  head: string,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): boolean {
  const moduleFile = pythonHeadModuleFile(head, ctx, mapper);
  if (moduleFile === null) return false;
  return ctx.symbolTable.lookup(member).filter((def) => def.relPath === moduleFile).length === 1;
}

/**
 * The placed class key of `member` when the head's module file does not declare
 * it but RE-EXPORTS it — `resolveExportedName`'s answer (explicit entries over
 * stars, stars unanimous or refused), accepted only where that file declares
 * the class once at top level, the same exact-symbolId gate as
 * {@link pythonHeadModuleDeclares}.
 */
function pythonHeadModuleReexportedClassKey(
  head: string,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null {
  const moduleFile = pythonHeadModuleFile(head, ctx, mapper);
  if (moduleFile === null) return null;
  const declaring = mapper.resolveExportedName(moduleFile, member, ctx);
  if (declaring === null || declaring === moduleFile) return null;
  const declared = ctx.symbolTable.lookup(member).filter((def) => def.relPath === declaring).length === 1;
  return declared ? pythonClassKey(declaring, member) : null;
}

/**
 * The TypeRef name a CapWords class head denotes, or `null`: the spelling
 * itself when it places into the project, else — only on that miss — the
 * placed key of the project class an import ALIASED under it (bd
 * tea-rags-mcp-m99j1.1.81). `from app.engine import Engine as E2` makes `E2()`
 * an `Engine`, and the bare `E2` places nowhere. The key and not the source
 * name, because the caller binds no `Engine` for a later hop to re-place. A
 * library alias and an unbound head answer `null`, exactly as before.
 */
function pythonClassHeadName(head: string, ctx: CallContext, mapper: PythonImportFileMapper): string | null {
  if (resolveTypeFile(head, ctx, mapper) !== null) return head;
  return pythonAliasedClassKey(head, ctx, mapper);
}

/**
 * `get_client()` as a chain HEAD: the callee's own recorded return type.
 *
 * `polar/integrations/polar/client.py` reads `def get_client() -> PolarSelfClient`
 * and 18 sites open `get_client().portal_get_customer()`; the return fact exists
 * and nothing asked for it, because the constructor arm refuses a lowercase head.
 *
 * The single-candidate gate is not a cardinality guess. `structuredReturnTypes`
 * keys a top-level `def` by its BARE name, so a second same-named def anywhere
 * in the corpus would let one file's answer speak for the other. Reachability is
 * the two arms a bare call has and nothing wider: the caller's own module scope,
 * or an import that maps into the project.
 */
function pythonCallHeadReturnType(
  receiver: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  // The lookup and its reachability gate moved to `strategies/shared.ts` when
  // E4.6c gave the same question a second asker at a FIELD assignment (bd
  // tea-rags-mcp-w205u). The lowercase gate lives there too, so a receiver
  // ending in `)` reduces to the callee and asks once.
  return pythonBareCallReturnType(stripCallArgs(receiver), ctx, mapper);
}

/**
 * `cast(T, x)` — the type IS argument one, so there is nothing to infer.
 *
 * `callText` arrives whole, parens included. The argument split reuses the
 * kernel's depth scanner rather than adding a second one, because a cast's
 * second argument routinely carries commas of its own. The type head is read
 * the way a class head is ({@link pythonClassHeadName}), so an import alias of
 * a project class (`cast(E2, x)`) types as that class (bd
 * tea-rags-mcp-m99j1.1.86).
 */
function pythonCastArgumentType(
  callText: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  const open = callText.indexOf("(");
  if (open === -1 || !callText.endsWith(")")) return undefined;
  const first = splitAtBracketDepthZero(callText.slice(open + 1, -1), ",")[0]?.trim();
  if (first === undefined) return undefined;
  const bare = stripPythonSubscript(first.slice(first.lastIndexOf(".") + 1));
  if (!PYTHON_CLASS_HEAD.test(bare)) return undefined;
  const name = pythonClassHeadName(bare, ctx, mapper);
  return name === null ? undefined : { form: "instance", name };
}

/** Was `cast` bound from `typing` / `typing_extensions` in this file? */
function pythonCastIsTyping(localName: string, ctx: CallContext): boolean {
  const bound = findPythonImportBinding(ctx.imports, localName);
  return bound !== null && bound.importedName === "cast" && PYTHON_TYPING_MODULES.has(bound.imp.importText);
}

/** Read the cap per call so a test env override needs no module reload. */
function pythonMaxHops(): number {
  const raw = process.env[PYTHON_CHAIN_MAX_HOPS_ENV];
  if (raw === undefined) return CHAIN_MAX_HOPS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAIN_MAX_HOPS_DEFAULT;
}

/**
 * `self` is the enclosing class as an INSTANCE; `Cls(…)` is a constructor call
 * and therefore also an instance; a bare name is a local variable. Nothing
 * else — an unbound bare name in Python is a `NameError`, not a self-call, so
 * Ruby's `nullaryReceiverType` has no analogue here.
 *
 * The local-variable branch is only ever reached as a chain HEAD: `localBinding`
 * runs before `chainType` and is terminal (resolved or DROP) for a bare bound
 * receiver, so a single-segment receiver never gets here.
 */
function pythonSingleHopType(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  classHead: boolean,
  ports: ReceiverTypePorts,
): TypeRef | undefined {
  if (receiver === "self") {
    // The enclosing CLASS, addressed the way the run keys classes — not the
    // trailing segment of `callerScope`, which is the enclosing `def` for a
    // call made from a nested one and drops the outer container for a class
    // declared inside one (bd tea-rags-mcp-6pd5l, the read side of graiw).
    // `classFq` and not `name`: the member channels this seed feeds are keyed
    // by the SYMBOL-TABLE spelling, so `Outer.Inner` addresses its own returns
    // where `Inner` addresses a module-level namesake's.
    const enclosing = pythonEnclosingClass(ctx);
    return enclosing === null ? undefined : { form: "instance", name: enclosing.classFq };
  }
  if (receiver.endsWith(")")) {
    // The subscript strip is what turns `Datatable[Benefit, S](…)` from a
    // failed class test into a head; the two arms after it are a call whose
    // return is recorded and a `cast` that states its type outright. Order is
    // load-bearing: a capitalized head keeps today's path exactly.
    const bare = stripPythonSubscript(stripCallArgs(receiver));
    if (PYTHON_CLASS_HEAD.test(bare)) {
      const name = pythonClassHeadName(bare, ctx, mapper);
      return name === null ? undefined : { form: "instance", name };
    }
    if (pythonCastIsTyping(bare, ctx)) return pythonCastArgumentType(receiver, ctx, mapper);
    return pythonCallHeadReturnType(receiver, ctx, mapper);
  }
  const bound = pythonBindingInForceAt(receiver, atLine, ctx);
  // A derived binding (loop, `with` or unpacking target) is typed by its fold
  // (bd tea-rags-mcp-m99j1.1.18) — and an untyped one still IS a binding: the
  // name a module or a class might carry elsewhere is a local here.
  if (isDerivedLocalBinding(bound)) return pythonDerivedBindingType(bound, ctx, ports, mapper);
  if (bound !== undefined) {
    // A union annotation (bd tea-rags-mcp-m99j1.1.30) is read from its arms,
    // never from `type`, which names none of them.
    const union = pythonPlacedBindingUnion(bound, ctx, mapper);
    if (union !== undefined) return union ?? undefined;
    return { form: "instance", name: bound.type };
  }
  const moduleValue = pythonModuleValueType(receiver, ctx, mapper);
  if (moduleValue !== undefined) return moduleValue;
  // A bare class name in receiver position: `Repo.from_session(…)` — CLASS
  // form, so `memberTypeOf` reads the `Cls.member` spelling a `@classmethod`
  // produces. Gated on the class resolving to a PROJECT file: `os.Path` in a
  // project that never imports `os` is not evidence, it is a coincidence of
  // capitalisation.
  if (!classHead || !PYTHON_CLASS_HEAD.test(receiver)) return undefined;
  const name = pythonClassHeadName(receiver, ctx, mapper);
  return name === null ? undefined : { form: "class", name };
}

/**
 * A module-scope VALUE as a receiver (P4, bd tea-rags-mcp-m99j1.1.15) — an
 * imported singleton (`from django.apps import apps`) or the caller module's
 * own global (`connections = ConnectionHandler()`).
 *
 * Every typed fold downstream resolves `type.name` in the CALLER's context, and
 * the value's class was named in the DECLARING file's. So the type is handed
 * on only where the two readings agree — the caller's resolution of the class
 * lands on the file the anchored key names. A disagreement is left to
 * `importedName`, which reads the anchored key directly.
 */
function pythonModuleValueType(
  receiver: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  const value = pythonModuleValueClass(receiver, ctx, mapper);
  if (value === null) return undefined;
  const anchored = parsePythonClassKey(value.classKey);
  const callerTypeFile = resolveTypeFile(lastSegment(value.type.name), ctx, mapper);
  return anchored !== null && callerTypeFile === anchored.relPath ? value.type : undefined;
}

/**
 * The binding a receiver actually carries at `atLine` — which is NOT always the
 * one `resolveLocalBinding` returns (R4c, bd tea-rags-mcp-jeqyg).
 *
 * `layout = layout.SimpleLayout(...)` in eleven netbox view files: the walker
 * records `layout -> SimpleLayout` at that line, and the fold then types the
 * RECEIVER of the very call that produced it. Python evaluates the right-hand
 * side before it rebinds the name, so on that statement `layout` still denotes
 * what `from netbox.ui import layout` bound — a MODULE. Typing it as the class
 * being constructed makes `chainType` look for `SimpleLayout` ON `SimpleLayout`,
 * find nothing, and DROP, which cuts off the module arm of `importedName` that
 * answers the site correctly. 165 rows.
 *
 * The narrow gate is the import list: the shadow only exists where an import
 * bound the same name, and there the prior binding is the import rather than
 * anything the walker recorded. Without that clause the rule would also demote
 * `x = Foo(); x.run()` on one line, which no evidence asks for. `line <= atLine`
 * in the shared lookup stays exactly as it is — the retry simply asks it for the
 * line before, so a name bound EARLIER in the body keeps that earlier type.
 *
 * The window is the STATEMENT, not its first line (bd tea-rags-mcp-w205u,
 * E4.6a). netbox's `layout = layout.Layout(\n    layout.Row(…))` puts the inner
 * receivers on lines 205, 206, 212 against a binding at 204, and a same-line
 * test sees none of them — 50 more rows of the identical shape. `endLine` is
 * the extent the walker records; ABSENT it degenerates to the same-line test it
 * replaces, so an index written by an earlier walker behaves exactly as before.
 *
 * The retry asks for `bound.line - 1` rather than `atLine - 1`: at line 210
 * against a binding at 204, the line before the CALL still finds the very
 * binding being demoted.
 */
function pythonBindingInForceAt(receiver: string, atLine: number, ctx: CallContext): LocalBinding | undefined {
  const bound = pythonLocalBindingInForce(ctx, receiver, atLine);
  if (bound === undefined || atLine > (bound.endLine ?? bound.line)) return bound;
  if (findPythonImportBinding(ctx.imports, receiver) === null) return bound;
  return pythonLocalBindingInForce(ctx, receiver, bound.line - 1);
}

/**
 * A head that is a module alias rather than a value: `mod.Cls()`.
 *
 * The link arrives RAW so the parens are still visible, and they decide the
 * form: `mod.Cls().run()` dispatches an INSTANCE method, `mod.Cls.run()` a
 * static one. Collapsing both to one form would send half these sites to the
 * wrong symbolId, which is the failure mode this program is gated against.
 *
 * The head must actually be imported and the class must actually be defined in
 * the file that import maps to. A capitalized first link alone is not
 * evidence — `os.Path` in a project that never imports `os` is nothing.
 */
function pythonSeedHead(
  head: string,
  firstLink: string | undefined,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 0 | 1 } | undefined {
  if (firstLink === undefined) return undefined;
  const cast = pythonTypingCastSeed(head, firstLink, ctx, mapper);
  if (cast !== undefined) return cast;
  const alias = pythonModuleAliasSeed(head, firstLink, ctx, mapper);
  return (
    alias ?? pythonClassChainHeadSeed(head, ctx, mapper) ?? pythonModuleAliasValueSeed(head, firstLink, ctx, mapper)
  );
}

/**
 * `signals.got_request_exception.send(...)` under `from django.core import
 * signals` (bd tea-rags-mcp-m99j1.1.72): the head is a MODULE alias and its
 * first link a module-level VALUE of that module, typed by the same
 * `moduleValueTypes` fact that types `from django.core.signals import
 * got_request_exception` — read off the module file the head names, or the one
 * that file re-exports the name from.
 *
 * Tried LAST, so every head another arm seeds keeps its seed. The link must be
 * a bare attribute: `signals.factory()` reads what calling the value returns.
 * The type travels as the PLACED class key, keyed from the VALUE's file, for the
 * reason the re-export arm above gives: the caller binds neither the value nor
 * its class, so re-placing the bare name from the caller's imports would refuse
 * or pick a namesake. A module, a name or a class that cannot be placed seeds
 * nothing.
 */
function pythonModuleAliasValueSeed(
  head: string,
  firstLink: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 1 } | undefined {
  if (!PYTHON_BARE_ATTRIBUTE_LINK.test(firstLink)) return undefined;
  const moduleFile = pythonHeadModuleFile(head, ctx, mapper);
  if (moduleFile === null) return undefined;
  const value = pythonModuleValueClassIn(moduleFile, firstLink, ctx, mapper);
  return value === null ? undefined : { type: { form: "instance", name: value.classKey }, consumedMembers: 1 };
}

/**
 * `typing.cast(T, x).m()` — the dotted spelling of the bare `cast` arm in
 * {@link pythonSingleHopType}. Three polar rows; it shares the argument reader
 * rather than growing a second one.
 */
function pythonTypingCastSeed(
  head: string,
  firstLink: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 1 } | undefined {
  if (!PYTHON_TYPING_MODULES.has(head) || !firstLink.startsWith("cast(")) return undefined;
  if (!ctx.imports.some((imp) => pythonImportMatchesReceiver(imp.importText, head))) return undefined;
  const type = pythonCastArgumentType(firstLink, ctx, mapper);
  return type === undefined ? undefined : { type, consumedMembers: 1 };
}

/** `mod.Cls()` / `mod.Cls` — the module-alias arm of {@link pythonSeedHead}. */
function pythonModuleAliasSeed(
  head: string,
  firstLink: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 1 } | undefined {
  const member = stripPythonSubscript(stripCallArgs(firstLink));
  if (!PYTHON_CLASS_HEAD.test(member)) return undefined;
  // Arm one, unchanged: the head reads as an imported module and the CALLER's
  // own imports pin the class. Arm two, one step wider (bd tea-rags-mcp-w205u):
  // ask the head's OWN module file whether it declares the class — the caller
  // never imports `Datatable`, only the module that holds it. Order keeps every
  // site that resolves today resolving to the same target.
  const viaCaller =
    ctx.imports.some((imp) => pythonImportMatchesReceiver(imp.importText, head)) &&
    resolveTypeFile(member, ctx, mapper) !== null;
  const form = firstLink.endsWith(")") ? "instance" : "class";
  if (viaCaller || pythonHeadModuleDeclares(head, member, ctx, mapper)) {
    return { type: { form, name: member }, consumedMembers: 1 };
  }
  // Arm three (bd tea-rags-mcp-m99j1.1.58): the head's package RE-EXPORTS the
  // class — django's `sql.DeleteQuery(model)`, whose `sql/__init__.py`
  // star-imports `subqueries`. The type travels as a PLACED key: the caller
  // binds neither the class nor its module, so re-placing the bare name from
  // the caller's imports would refuse or pick a namesake.
  const placed = pythonHeadModuleReexportedClassKey(head, member, ctx, mapper);
  return placed === null ? undefined : { type: { form, name: placed }, consumedMembers: 1 };
}

/**
 * A bare CLASS name as a CHAIN head: `ObjectType.objects.get_for_model(m)` (bd
 * tea-rags-mcp-xpl83).
 *
 * The class-body field facts type `<Model>.objects`, and this is what lets the
 * fold reach them. It is deliberately the chain-head half of `singleHopType`'s
 * `classHead` arm and not that arm itself: `seedHead` is reached ONLY from
 * `propagateChain`, so a single-segment `Cls.member()` receiver never sees it and
 * keeps going to `importedName` exactly as it does today — which is what the
 * `classHead` default protects.
 *
 * Seeding is inert by construction. `consumedMembers: 0` hands the first link
 * straight to `memberTypeOf`, and stop-at-unknown-hop unwinds the whole receiver
 * to untyped unless that link has a real field or return fact. A class with no
 * `objects` attribute folds to nothing and the call reaches the same strategy it
 * reaches today.
 *
 * A local binding on the same name WINS: `singleHopType` would have typed the
 * head from it, and a name Python rebound is a value rather than the class.
 */
function pythonClassChainHeadSeed(
  head: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 0 } | undefined {
  if (!PYTHON_CLASS_HEAD.test(head)) return undefined;
  if (identifierEntry(ctx.localBindings, head) !== undefined) return undefined;
  const name = pythonClassHeadName(head, ctx, mapper);
  return name === null ? undefined : { type: { form: "class", name }, consumedMembers: 0 };
}

/**
 * What calling / accessing `member` on a receiver of type `recv` yields.
 *
 * Two channels, attribute first:
 *  1. `classFieldTypes[<class>][member]` — `self.repo` inside `Svc` is a
 *     `Repo`, written by the walker's `__init__` inference and by the
 *     annotation facet's `ivar` facts.
 *  2. `structuredReturnTypes[<symbolId>]` — what `member` RETURNS, keyed by the
 *     callee's own symbolId: `Cls#member` on an instance receiver,
 *     `Cls.member` on a class receiver. Nested owners already arrive joined
 *     with `.` (`python/kernel.ts:41`), so never re-compose the key.
 *
 * An attribute and a method can share a name; the attribute is the narrower
 * statement (it names the class that owns it) and `classFieldTypes` only holds
 * constructor-assigned or annotated fields, so it is the safer first read.
 *
 * A `container` or `union` receiver yields nothing: Python's `list[Foo]` types
 * the LIST, not an element, so unwrapping it the way Ruby unwraps a YARD
 * `Array<Post>` would resolve `xs.append` against `Foo`. The annotation facet
 * already declines to emit those as bindings (its decision 4); this is the same
 * rule stated on the read side.
 *
 * Both channels are read UP THE MRO, not just on the class the receiver names
 * (bd tea-rags-mcp-yl85b) — see `pythonInheritedMemberType`. This is the one
 * place either channel is consulted, so the walk lives there and not in each
 * strategy.
 *
 * `access` splits the kernel's two reads (bd tea-rags-mcp-m99j1.1.20):
 * `memberTypeOf` is the CALL read, `memberAttributeTypeOf` the read of a link
 * with no argument list, which never types a known plain method by its return.
 * See `PythonMemberAccess`.
 */
function pythonMemberTypeOf(
  recv: TypeRef,
  member: string,
  access: PythonMemberAccess,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  const read = access === "call" ? pythonInheritedMemberType : pythonInheritedAttributeType;
  return read(recv.name, member, recv.form, ctx, mapper, linearizers?.for(ctx), recv.args);
}

/**
 * Python's `ReceiverTypePorts`, bound to the resolver's own import mapper.
 * Call it ONCE per resolver and hand the result to `propagateReceiverType`.
 *
 * `linearizers` is the run's ancestor-MRO cache, threaded exactly as the mapper
 * is (bd tea-rags-mcp-yl85b). It stays OPTIONAL so every existing construction
 * site compiles untouched and keeps the own-class-only read; the cache itself
 * answers `undefined` on an index carrying no `classAncestors`, so the pre-seam
 * behaviour is a property of the CONTEXT rather than of the caller.
 *
 * `options.classHead` opts into the bare-class receiver arm and defaults OFF
 * (bd tea-rags-mcp-z68v9). `Repo.member()` reaching `chainType` with that arm
 * on would be answered THERE, one pass earlier than `importedName` and through
 * the weaker legacy `classExtends` walk rather than the MRO — a strict
 * downgrade on a receiver kind already sitting at 1,297/1,309 on polar. The arm
 * therefore belongs to the one consumer with no other way to type a callee's
 * receiver; see {@link createPythonCallBindingPorts}.
 */
export function createPythonReceiverTypePorts(
  mapper: PythonImportFileMapper,
  linearizers?: PythonAncestorLinearizerCache,
  options: { readonly classHead?: boolean } = {},
): ReceiverTypePorts {
  const classHead = options.classHead ?? false;
  const memberTypeOf = (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined =>
    pythonMemberTypeOf(recv, member, "call", ctx, mapper, linearizers);
  const ports: ReceiverTypePorts = Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      pythonSingleHopType(receiver, atLine, ctx, mapper, classHead, ports),
    seedHead: (
      head: string,
      firstLink: string | undefined,
      ctx: CallContext,
    ): { type: TypeRef; consumedMembers: 0 | 1 } | undefined => pythonSeedHead(head, firstLink, ctx, mapper),
    memberTypeOf,
    memberAttributeTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined =>
      pythonMemberTypeOf(recv, member, "attribute", ctx, mapper, linearizers),
    elementTypeOf: (container: TypeRef, ctx: CallContext): TypeRef | null =>
      pythonElementTypeOf(container, ctx, memberTypeOf),
    ownerIndependentMemberType: pythonOwnerIndependentMemberType,
    maxHops: pythonMaxHops,
    // Python opts INTO the bracket-aware hop split; Ruby keeps `split(".")`.
    // See the port's docblock for the 34 mastodon sites that decided it.
    splitReceiverHops,
  });
  return ports;
}

/**
 * The ports the call-binding fold uses — {@link createPythonReceiverTypePorts}
 * plus the bare-class receiver arm (bd tea-rags-mcp-z68v9).
 *
 * `repository = SubscriptionRepository.from_session(session)` is 338 of polar's
 * 470 `localVar` misses, and its callee's receiver is a bare CLASS name. No
 * other consumer needs that arm — every other receiver a chain folds is a
 * `self`, a constructor call or a local — and turning it on globally would move
 * `Cls.member()` sites off `importedName`. One extra frozen object per
 * resolver buys that separation.
 */
export function createPythonCallBindingPorts(
  mapper: PythonImportFileMapper,
  linearizers?: PythonAncestorLinearizerCache,
): ReceiverTypePorts {
  return createPythonReceiverTypePorts(mapper, linearizers, { classHead: true });
}
