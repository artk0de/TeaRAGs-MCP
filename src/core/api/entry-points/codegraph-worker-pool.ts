/**
 * Narrow worker-time read for the bootstrap codegraph worker pool factory
 * (bd tea-rags-mcp-h4a H4a2+3 follow-up).
 *
 * `bootstrap/codegraph-worker-pool-factory.ts` is loaded BY PATH in every
 * codegraph worker thread and working-tree graph build child
 * (`loadCodegraphPoolBuilder`). Routing it through the api assembly barrel
 * (`../index.ts`) loaded the whole api graph into each of them — measured
 * ~582 ms / +58 MB heap per worker against ~138 ms / +12 MB. This file
 * re-exports only what the pool factory needs, from the codegraph FACADES,
 * so bootstrap still reaches the domain through `core/api`
 * (`domain-boundaries.md`).
 */
export { InMemoryGlobalSymbolTable } from "../../domains/trajectory/codegraph/symbols/index.js";
export type { CodegraphWorkerConfig } from "../../domains/trajectory/codegraph/index.js";
