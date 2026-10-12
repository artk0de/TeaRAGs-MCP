/**
 * Project Registry shared constants.
 *
 * Single source of truth for runtime values consumed by multiple layers
 * (CollectionRegistry, ProjectRegistryOps, MCP register_project tool).
 * Types belong in types.ts; this file holds regex / numeric / string
 * primitives that survive a Zod schema rebuild.
 *
 * `PROJECT_NAME_RE` itself now lives in `contracts/types/registry.ts`
 * (bd tea-rags-mcp-k7kmu C3 — a pure regex is contract vocabulary, and the
 * stable layers must not reach into this domain for it); this module
 * re-exports it unchanged for the registry domain's own consumers.
 */

export { PROJECT_NAME_RE } from "../../../contracts/types/registry.js";
