/**
 * Simple cyclomatic complexity estimation based on control flow patterns.
 */

const CONTROL_FLOW_PATTERNS = [
  /\bif\b/g,
  /\belse\b/g,
  /\bfor\b/g,
  /\bwhile\b/g,
  /\bswitch\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /&&/g,
  /\|\|/g,
  /\?[^?]/g, // Ternary operator
];

export function calculateComplexity(code: string): number {
  if (!code || code.trim().length === 0) {
    return 0;
  }

  let complexity = 0;

  for (const pattern of CONTROL_FLOW_PATTERNS) {
    const matches = code.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  // If code contains function/method/class, add base complexity of 1
  if (complexity > 0 || /\b(function|class|def|fn)\b/.test(code)) {
    complexity = Math.max(1, complexity);
  }

  return complexity;
}
