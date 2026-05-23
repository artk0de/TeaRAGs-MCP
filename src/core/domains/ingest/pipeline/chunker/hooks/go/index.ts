/**
 * Go chunker hooks.
 *
 * No hook chain registered (Go has no DSL / class-body / test-DSL
 * scopes that need claiming). The `symbol-resolver.ts` helper is a
 * pure utility consumed directly by `chunkSingleNode` to compose
 * `Receiver#Method` and `type Foo {...}` symbolIds matching the
 * codegraph `goNameOf` output.
 *
 * bd tea-rags-mcp-n7x5, bd tea-rags-mcp-j2b7
 */
export { extractGoSymbol, type GoSymbol } from "./symbol-resolver.js";
