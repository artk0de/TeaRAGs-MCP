#!/bin/bash
# Check test coverage meets minimum threshold

THRESHOLD=${COVERAGE_THRESHOLD:-70}
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

cd "$PROJECT_DIR"

# Run tests with coverage
npm test -- --run --coverage --reporter=json --outputFile=coverage/coverage-summary.json 2>/dev/null

if [ ! -f "coverage/coverage-summary.json" ]; then
  echo "Coverage report not generated"
  exit 0  # Don't block if coverage not configured
fi

# Extract line coverage percentage
COVERAGE=$(cat coverage/coverage-summary.json | jq -r '.total.lines.pct // 0')

if [ -z "$COVERAGE" ] || [ "$COVERAGE" = "null" ]; then
  echo "Could not parse coverage"
  exit 0
fi

# Compare with threshold
if (( $(echo "$COVERAGE < $THRESHOLD" | bc -l) )); then
  echo "================================================" >&2
  echo "Coverage ${COVERAGE}% is below ${THRESHOLD}% threshold" >&2
  echo "Run: npm test -- --coverage" >&2
  echo "================================================" >&2
  exit 2
fi

echo "Coverage OK: ${COVERAGE}% (threshold: ${THRESHOLD}%)"
exit 0
