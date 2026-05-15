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
 * **Single source of truth.** Consumed by:
 * - CollectionRegistry.setName (runtime validation)
 * - ProjectRegistryOps.register (input validation)
 * - api/internal/infra/schema-builder.ts (Zod schema)
 * - mcp/tools/register-project (Zod schema via PROJECT_NAME_RE.source)
 * - mcp/tools/schemas.ts (Zod schema via PROJECT_NAME_RE.source)
 * - cli/commands/projects.ts (describe string)
 *
 * Do not redeclare locally — import from this file.
 */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
