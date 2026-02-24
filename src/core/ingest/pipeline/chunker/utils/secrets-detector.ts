/**
 * Basic secret detection in source code via pattern matching.
 */

const SECRET_PATTERNS = [
  /(?:api[-_]?key|apikey)\s*=\s*['"][^'"]{20,}['"]/i,
  /(?:secret|SECRET)\s*=\s*['"][^'"]{20,}['"]/i,
  /(?:password|PASSWORD)\s*=\s*['"][^'"]{8,}['"]/i,
  /(?:token|TOKEN)\s*=\s*['"][^'"]{20,}['"]/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /sk_live_[a-zA-Z0-9]{24,}/, // Stripe secret key
  /ghp_[a-zA-Z0-9]{36,}/, // GitHub personal access token
  /AIza[0-9A-Za-z\\-_]{35}/, // Google API key
  /AKIA[0-9A-Z]{16}/, // AWS access key
];

export function containsSecrets(code: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(code)) {
      return true;
    }
  }
  return false;
}
