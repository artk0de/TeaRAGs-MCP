---
title: Development Setup
sidebar_position: 4
---

## Commands

```bash
npm run dev          # Development with auto-reload
npm run build        # Production build
npm run type-check   # TypeScript validation
npm test             # Run unit test suite (mocked, fast)
npm run test:coverage # Coverage report
npm run test-integration # Run real integration tests (requires Qdrant + Ollama)
```

## Testing

**Unit Tests**: 864+ tests with 97%+ coverage (mocked, fast)

**Integration Tests**: 233 tests across 18 suites against real Qdrant + Ollama

```bash
npm run test-integration           # Run all
TEST_SUITE=1 npm run test-integration  # Run specific suite (1-18)
SKIP_CLEANUP=1 npm run test-integration # Debug mode
```

**CI/CD**: GitHub Actions runs build, type-check, and tests on Node.js 22 LTS for every push/PR.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](https://github.com/artk0de/tea-rags/blob/main/CONTRIBUTING.md) for:

- Development workflow
- Conventional commit format (`feat:`, `fix:`, `BREAKING CHANGE:`)
- Testing requirements (run `npm test`, `npm run type-check`, `npm run build`)

**Automated releases**: Semantic versioning via conventional commits — `feat:` = minor, `fix:` = patch, `BREAKING CHANGE:` = major.
