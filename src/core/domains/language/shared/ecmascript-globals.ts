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
 * receiver typed as one is not a builtin instance (keeps it an internal miss).
 */
export const ECMASCRIPT_BUILTIN_TYPES: ReadonlySet<string> = new Set([
  // Collections
  "Map",
  "WeakMap",
  "Set",
  "WeakSet",
  "WeakRef",
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
]);
