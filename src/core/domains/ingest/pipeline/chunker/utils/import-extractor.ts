/**
 * Regex-based import/export extraction from source code.
 */

export function extractImportsExports(
  code: string,
  language: string,
): {
  imports: string[];
  exports: string[];
} {
  const imports: string[] = [];
  const exports: string[] = [];

  if (language === "typescript" || language === "javascript") {
    // Extract imports
    const importMatches = code.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      imports.push(match[1]);
    }

    // Extract require statements
    const requireMatches = code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of requireMatches) {
      imports.push(match[1]);
    }

    // Extract exports - regular declarations
    const exportMatches = code.matchAll(/export\s+(?:class|function|const|let|var)\s+(\w+)/g);
    for (const match of exportMatches) {
      exports.push(match[1]);
    }

    // Extract export default
    if (/export\s+default\b/.test(code)) {
      exports.push("default");
    }

    // Extract named exports from other modules: export { name } from 'module'
    const reExportMatches = code.matchAll(/export\s+\{\s*(\w+)\s*\}/g);
    for (const match of reExportMatches) {
      exports.push(match[1]);
    }
  } else if (language === "python") {
    // Extract imports
    const importMatches = code.matchAll(/(?:from\s+(\S+)\s+)?import\s+([^;\n]+)/g);
    for (const match of importMatches) {
      imports.push(match[1] || match[2]);
    }

    // Extract functions/classes (rough)
    const defMatches = code.matchAll(/^(?:def|class)\s+(\w+)/gm);
    for (const match of defMatches) {
      exports.push(match[1]);
    }
  }

  return { imports, exports };
}
