---
title: Non-Goals
sidebar_position: 3
---

TeaRAGs is focused on a specific problem space. Understanding what it does
**not** aim to do is as important as understanding what it does.

## Not a General-Purpose Vector Database

TeaRAGs uses Qdrant as its storage backend, but it is not a general-purpose
vector database interface. It is purpose-built for code search with development
history awareness.

## Not _Another_ Code Analysis Tool

TeaRAGs **can** analyze code — and does it well. Trajectory enrichment provides
real metrics at **function-level granularity**: stability, churn, ownership,
bug-fix rates, code age — per function, per method, not just per file. This
makes it a powerful tool for hotspot detection, tech debt scoring, and ownership
mapping.

However, the **primary focus** is intelligent code generation, not analysis for
its own sake. The analysis capabilities exist to make retrieval smarter — so
agents find the _right_ code to learn from, not just similar code. TeaRAGs is
not a static analysis tool, linter, or code quality dashboard. It's an
intelligence layer that _uses_ analysis signals to produce better search results
and better-informed code generation.

## Not a Replacement for grep/ripgrep

For exact string matching, use ripgrep. TeaRAGs excels at semantic queries ("how
does authentication work?") not literal text search ("find all occurrences of
`AUTH_TOKEN`").

## Not a CI/CD Component

TeaRAGs is designed for interactive use by developers and AI agents. It is not
optimized for pipeline automation or batch processing in CI/CD workflows.

## Not a Dinosaur Simulator

Despite the logo, TeaRAGs will not help you clone dinosaurs, brew tea, or type
with tiny arms. It _will_ help your coding agent make smarter decisions — which
is arguably more useful. 🦖
