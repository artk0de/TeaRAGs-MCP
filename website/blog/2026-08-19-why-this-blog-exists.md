---
slug: why-this-blog-exists
title: Why this blog exists
authors: [artk0de]
tags: [retrieval, agents]
---

The [changelog](/changelog) tells you what shipped. It does not tell you why a
ranking signal was added, which three hypotheses died before the fourth one
held, or what the numbers looked like before and after. That is what this blog
is for.

<!-- truncate -->

## What goes here

TeaRAGs is an MCP server for code search that enriches every retrieved chunk
with git history — authorship, churn, bug-fix rate, ownership — so an agent
ranks stable, owned code above whatever merely looks similar. Most of the
interesting work behind that sentence is invisible in a release note:

- **Retrieval** — why a rerank preset weights the signals it does, and what
  happens to result quality when the weights are wrong.
- **Codegraph** — symbol resolution against real corpora, where the resolver
  chain gives up, and what the residual gap actually consists of.
- **Performance** — indexing throughput, profiling runs, measured wins and the
  optimizations that turned out to be noise.
- **Agents** — how a coding agent consumes this data, and where the tooling
  still hands it the wrong thing.

Posts here are measurement-first. A claim about ranking or throughput arrives
with the corpus it was measured on and the number it moved.

## Where the rest lives

- [Documentation](/) — installation, tools, configuration, architecture.
- [Changelog](/changelog) — every released version, generated from commits.
- [GitHub](https://github.com/artk0de/TeaRAGs-MCP) — source, issues, releases.

The blog has an [RSS feed](https://artk0de.github.io/TeaRAGs-MCP/blog/rss.xml)
and an [Atom feed](https://artk0de.github.io/TeaRAGs-MCP/blog/atom.xml) if you
would rather not check back.
