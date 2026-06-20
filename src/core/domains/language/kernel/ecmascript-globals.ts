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
