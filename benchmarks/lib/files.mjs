// benchmarks/lib/files.mjs
import { execSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { extname, join } from "path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rb",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".kt",
  ".vue",
  ".svelte",
  ".md",
]);

export function collectSourceFiles(projectPath, { maxFiles = 500 } = {}) {
  let filePaths;
  try {
    const output = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: projectPath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    filePaths = output.trim().split("\n").filter(Boolean);
  } catch {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  const files = [];
  for (const rel of filePaths) {
    if (!SOURCE_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    const abs = join(projectPath, rel);
    try {
      const stat = statSync(abs);
      if (stat.isFile() && stat.size > 0 && stat.size < 1_000_000) {
        files.push({ path: abs, relativePath: rel, size: stat.size });
      }
    } catch {
      continue;
    }
    if (files.length >= maxFiles) break;
  }

  return files;
}

export function preloadFiles(files) {
  return files.map((f) => ({
    path: f.path,
    content: readFileSync(f.path, "utf-8"),
    language: detectLanguage(extname(f.path)),
  }));
}

function detectLanguage(ext) {
  const map = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".rb": "ruby",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "c_sharp",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".vue": "vue",
    ".svelte": "svelte",
    ".md": "markdown",
  };
  return map[ext.toLowerCase()] || "text";
}
