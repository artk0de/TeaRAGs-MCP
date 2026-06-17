import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const securityPathsFilterPreset: FilterPresetDef = {
  name: "securityPaths",
  description:
    "Files on security-sensitive paths (auth, crypto, secrets, tokens, credentials, permissions).",
  conditions: [
    { signal: "relativePath", op: "contains", value: "auth", occur: "should" },
    { signal: "relativePath", op: "contains", value: "crypto", occur: "should" },
    { signal: "relativePath", op: "contains", value: "secret", occur: "should" },
    { signal: "relativePath", op: "contains", value: "token", occur: "should" },
    { signal: "relativePath", op: "contains", value: "password", occur: "should" },
    { signal: "relativePath", op: "contains", value: "credential", occur: "should" },
    { signal: "relativePath", op: "contains", value: "permission", occur: "should" },
  ],
};
