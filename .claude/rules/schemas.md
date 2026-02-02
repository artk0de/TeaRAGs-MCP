---
paths:
  - "src/tools/schemas.ts"
---

# MCP Schema Standards

## Zod Schema Requirements

Every tool parameter MUST have `.describe()` - this is how MCP protocol communicates parameter purpose to AI agents.

```typescript
export const ToolNameSchema = {
  // Required parameter
  requiredParam: z.string().describe("Clear description of what this parameter does"),

  // Optional with default
  optionalParam: z
    .number()
    .optional()
    .describe("Description including default value (default: 5)"),

  // Enum
  mode: z
    .enum(["option1", "option2"])
    .optional()
    .describe("Available modes: option1 (does X), option2 (does Y)"),

  // Complex object
  filter: z
    .record(z.any())
    .optional()
    .describe("Qdrant filter object with must/should/must_not conditions"),
};
```

## Naming Conventions

- Schema name: `{ToolName}Schema` (PascalCase + Schema suffix)
- Export all schemas from `schemas.ts`
- Group related schemas together

## Description Guidelines

Good descriptions include:
- What the parameter does
- Valid values or format
- Default value (if optional)
- Example (for complex types)

Bad:
```typescript
limit: z.number().optional().describe("Limit")
```

Good:
```typescript
limit: z
  .number()
  .optional()
  .describe("Maximum number of results to return (default: 5, max: 100)")
```

## After Schema Changes

1. Update handler to destructure new params
2. Update tests
3. Update README.md if user-facing
4. Run `npm run type-check` to validate
