/**
 * tea-rags-mcp-ykj7 — ECMAScript / Node runtime ambient globals shared by the
 * TypeScript and JavaScript resolvers' `targetsExternalImport` classifier.
 *
 * A call whose receiver is one of these names (`Math.max`, `JSON.parse`,
 * `console.log`, `Object.keys`, …) targets the language runtime, not a
 * project-internal symbol — there is no import to match because the binding is
 * ambient. Such calls are correctly UNRESOLVED by the symbol-table resolver;
 * this set lets the provider exclude them from the `resolveSuccessRate`
 * denominator instead of counting them as resolver misses.
 *
 * Curated to the receivers that actually appear as method-call heads in source
 * (constructors / namespaces with static members), NOT every spec global. Kept
 * conservative: a name omitted here merely stays in the attempted-unresolved
 * pool (never over-shrinks the denominator).
 */
export const ECMASCRIPT_GLOBALS: ReadonlySet<string> = new Set([
  // Core namespaces with static members
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Reflect",
  "Proxy",
  "Promise",
  "Date",
  "RegExp",
  "Function",
  // Collections
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  // Typed arrays / binary
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  // Errors
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  // Web / Node ambient
  "console",
  "process",
  "Buffer",
  "globalThis",
  "Intl",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  // DOM / BOM ambient (bd tea-rags-mcp-4008o — taxdome React measurement)
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "history",
  "location",
  "screen",
  "crypto",
  "performance",
]);

/**
 * ECMAScript / Node runtime builtin CONSTRUCTOR / TYPE names — the set used by
 * the TypeScript resolver's `targetsExternalImport` to classify a call by its
 * RECEIVER TYPE (not by the receiver text). A variable typed as one of these
 * (`const m = new Map()`, `private pending = new Map()`, `p: Promise<T>`) whose
 * method call (`m.get()`, `this.pending.set()`, `p.then()`) the symbol-table
 * resolver cannot pin is targeting the JS runtime instance method, NOT an
 * in-repo symbol — exactly like a `node:fs` import or `Math.max()`. Such calls
 * must increment `callsExternalSkipped` so they leave the internal
 * `resolveSuccessRate` denominator. Mirrors Ruby ykj7 (commit 1dade557 —
 * classify bare Kernel/core builtins as external).
 *
 * Distinct from `ECMASCRIPT_GLOBALS`: that set matches the receiver TEXT for
 * namespace-style static calls (`Math.max`, `JSON.parse`, `console.log`); THIS
 * set matches an INSTANCE's declared TYPE for method calls on builtin objects.
 * Curated to the builtins whose instances carry runtime instance methods that
 * show up as call heads. Deliberately EXCLUDES TS-only utility types
 * (`Record`, `Partial`, `Readonly`, …) — they have no runtime constructor and a
 * receiver typed as one is not a builtin instance. Absence here does NOT make
 * such a receiver internal: those names are type-level operators pinning no
 * runtime object at all, so `ts-external-call.ts` treats them as UNKNOWN and
 * lets the member vocabulary decide (bd tea-rags-mcp-yjqi5).
 */
export const ECMASCRIPT_BUILTIN_TYPES: ReadonlySet<string> = new Set([
  // Collections
  "Map",
  "WeakMap",
  "Set",
  "WeakSet",
  "WeakRef",
  // Read-only VIEWS of the collections above (bd tea-rags-mcp-6b3gj). These are
  // TS-only type names with no runtime constructor, like `Record` / `Partial`
  // below — but unlike those they DENOTE a builtin instance: a value annotated
  // `ReadonlySet<string>` is a `Set` at runtime and its `.has()` is
  // `Set.prototype.has`. The exclusion below is about types with no runtime
  // object behind them, not about every type TS adds.
  "ReadonlyMap",
  "ReadonlySet",
  "ReadonlyArray",
  // Async
  "Promise",
  // Indexed / structural objects
  "Array",
  "Object",
  "Date",
  "RegExp",
  // Primitive wrapper objects (instances carry runtime methods)
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  // Reflection / proxy
  "Proxy",
  "Function",
  // Typed arrays / binary
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  // Errors
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  // Web / Node ambient instances
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "Buffer",
  // DOM / BOM instance types (bd tea-rags-mcp-4008o — taxdome React
  // measurement). `Request` / `Response` are DELIBERATELY excluded: they are
  // exactly the "look-alike" case this file's own `receiverIsExternalInstance`
  // docblock warns about — Express-style backend frameworks routinely declare
  // their own `Request`/`Response`, and `ts-annotated-external-receiver-guard.test.ts`
  // (bd tea-rags-mcp-3somv) already pins that a bare type name must not decide
  // this outright; those two stay on the checker-arm path (case 4b), same as
  // before this change.
  "Event",
  "CustomEvent",
  "FormData",
  "Blob",
  "File",
  "FileReader",
  "AbortController",
  "Headers",
  "IntersectionObserver",
  "MutationObserver",
  "ResizeObserver",
  "WebSocket",
  "Image",
  "Audio",
]);

/**
 * bd tea-rags-mcp-6b3gj — builtin prototype METHOD names, the last-resort
 * vocabulary for a receiver nothing in the chain could type.
 *
 * The oracle (`scripts/ts-codegraph-typechecker-oracle.ts`) found that most
 * phantom edges on real code sit on receivers with no type information at all:
 * `const out: string[] = []` carries no constructor to read, so
 * `out.push(name)` reached the short-name passes untyped and matched whatever
 * single project symbol happened to be called `push`. Type-based classification
 * (`ECMASCRIPT_BUILTIN_TYPES`) cannot see those; the member name is the only
 * evidence left.
 *
 * Which makes the curation the whole design. Guessing wrong here is the
 * OPPOSITE bug — a real project method suppressed, recall traded away to buy
 * precision — so membership is limited to words with no comparably-common
 * project-code meaning. `push` / `splice` / `flatMap` are Array vocabulary
 * wherever they appear; `get`, `set`, `has`, `write`, `map` are NOT, because
 * project code defines those constantly, and they are deliberately absent even
 * though they cost phantom edges. Those cases are left to the type-based path,
 * which answers them without guessing.
 *
 * Read only when {@link ECMASCRIPT_BUILTIN_TYPES} could not decide: a receiver
 * with a known type never consults this set, so a project class exposing
 * `push()` keeps its edges as long as the receiver is typed.
 */
export const ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  // Array mutators — no comparably-common project meaning
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "copyWithin",
  "fill",
  "reverse",
  // Array queries / transforms of the same family
  "concat",
  "flat",
  "flatMap",
  "indexOf",
  "lastIndexOf",
  "findIndex",
  "findLastIndex",
  // Membership on the keyed collections. `has` is the one Map/Set word that
  // survives the "no comparably-common project meaning" test: a project type
  // that answers `has` is a registry or cache wrapper, and those are reached
  // through a receiver the walker types (`this.registry`, `new Registry()`),
  // where the TYPE decides and this set is never consulted. Its siblings `get`
  // / `set` / `add` / `delete` fail that test outright — accessors, caches and
  // repositories define them constantly — and stay out even though they cost
  // measured phantom edges.
  "has",
]);

/**
 * bd tea-rags-mcp-4kx9f — prototype methods of the builtin CONTAINERS
 * (`Array`, `Set`, `Map`, `RegExp`), read only for a receiver that is an
 * IMPORTED CONSTANT.
 *
 * Separate from {@link ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS} because the
 * evidence behind it is different, and stronger. That set is last-resort: it
 * sees receivers nothing could type, anywhere, so a word in it suppresses the
 * member everywhere and its curation has to survive that. This set is consulted
 * only after the resolver has established two facts about the call — the
 * receiver is bound by an import that maps INTO the project, and no file
 * declares that receiver as a symbol. `tsNameOf` names classes, functions and
 * methods, so a receiver missing from the symbol table is a module-level
 * `const`; an imported CLASS is a symbol and never reaches here.
 *
 * That precondition is what makes words this set could not otherwise afford
 * safe. `find` is `UserRepo.find` all over real code — but `UserRepo` is a
 * class, so the guard never fires on it, while `STRUCTURED_MACROS.find(…)` is
 * `Array.prototype.find` on a constant array. The measured shape is
 * `YARD_CONST.test(text)` / `CODE_LANGUAGES.has(lang)` /
 * `UNSUPPORTED_FALLBACK.map(…)`: the import resolves to the file DECLARING the
 * constant, and the call enters the JS runtime instead.
 *
 * The accessor family (`get` / `set` / `add` / `delete` / `clear`) stays out for
 * the same reason it is absent above: a constant CAN be an object-literal
 * namespace whose methods `tsNameOf` does not index, and those namespaces are
 * named with exactly those verbs. Iteration and matching verbs carry no such
 * risk.
 */
export const ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  // RegExp matching — a constant regex is the single most common shape here.
  "test",
  "exec",
  // Array iteration / transformation. Every one of these takes a callback or
  // produces a new collection; none is a plausible name for a namespace's own
  // operation.
  "map",
  "filter",
  "find",
  "findLast",
  "some",
  "every",
  "forEach",
  "reduce",
  "reduceRight",
  "join",
]);

/**
 * bd tea-rags-mcp-4008o — JS/Node/browser ambient globals callable with NO
 * receiver at all (`parseInt(x)`, `fetch(url)`, `setTimeout(fn, ms)`). Distinct
 * from {@link ECMASCRIPT_GLOBALS}, which matches receiver TEXT for
 * namespace-style calls (`Math.max`) — this set matches the bare call's
 * `member` directly, since a free call carries no receiver for that set to
 * match against.
 *
 * `ts-external-call.ts`'s `targetsExternalImport` case 6
 * (`calleeIsExternalLocalBinding`) only classifies identifiers whose TS
 * declaration is a local `Parameter` / `BindingElement` / function-body-local
 * `VariableDeclaration` (closures, hook returns) — never a true ambient global,
 * whose declaration lives in `lib.es5.d.ts` / `lib.dom.d.ts` at the global
 * scope. Before this set existed, these names left the `resolveSuccessRate`
 * denominator only when no project symbol happened to share them (lexical
 * accident, tea-rags-mcp-4008o) — this set excludes them by classification,
 * unconditionally.
 *
 * `String` / `Number` / `Boolean` appear here in their BARE CONVERTER-CALL
 * shape (`String(x)`), distinct from their entries in {@link ECMASCRIPT_GLOBALS}
 * which match the receiver-text namespace-call shape (`String.fromCharCode(c)`).
 */
export const BARE_GLOBAL_CALLABLES: ReadonlySet<string> = new Set([
  // Numeric / string conversion
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "String",
  "Number",
  "Boolean",
  // Timers
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "queueMicrotask",
  // Networking / encoding
  "fetch",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "btoa",
  "atob",
  "structuredClone",
  // User-interaction ambient globals (browser)
  "alert",
  "confirm",
  "prompt",
]);
