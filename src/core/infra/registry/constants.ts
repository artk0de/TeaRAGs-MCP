/**
 * Project Registry shared constants.
 *
 * Single source of truth for runtime values consumed by multiple layers
 * (CollectionRegistry, ProjectRegistryOps, MCP register_project tool).
 * Types belong in types.ts; this file holds regex / numeric / string
 * primitives that survive a Zod schema rebuild.
 */

/**
 * Valid project-alias regex. Constraints: lowercase letters, digits, dash,
 * underscore; must start with letter or digit; max 64 chars.
 *
 * Consumed by:
 * - CollectionRegistry.setName (runtime validation)
 * - ProjectRegistryOps.register (input validation)
 * - mcp/tools/register-project (Zod schema via PROJECT_NAME_RE.source)
 */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
