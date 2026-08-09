# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security problem.** Use one of these
private channels instead — either is fine, pick whichever you prefer:

- **Email** — art2rik.desperado@gmail.com, with `[tea-rags security]` in the
  subject line.
- **GitHub Private Vulnerability Reporting** — the _Report a vulnerability_
  button on the repository's
  [Security tab](https://github.com/artk0de/TeaRAGs-MCP/security/advisories/new).

Include as much of this as you have:

- tea-rags version (`tea-rags --version`) and how it was installed
- OS and Node version
- which parts are involved: embedding provider (`onnx`, `ollama`, `openai`,
  `cohere`, `voyage`), Qdrant mode (external or embedded), transport (stdio or
  HTTP)
- reproduction steps — a minimal repository or single file that triggers the
  behavior is worth more than a description
- the impact as you understand it

Do not paste proprietary source code into a report. tea-rags indexes real
codebases, so a minimal reproduction file is both safer for you and easier to
work with.

## Response Timeline

| Stage                                        | Target                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| Acknowledgement that the report was received | 3 business days                                           |
| Initial assessment — valid or not, severity  | 7 days                                                    |
| Fix released                                 | 90 days from the report, usually far sooner               |
| Public advisory                              | when the fix ships, or at 90 days — whichever comes first |

Releases are automated with semantic-release: once a fix merges to `main` it is
published to npm as a new release without a manual step, so the release itself
is rarely what holds a fix up.

If you get no acknowledgement inside that first window, resend — email gets
lost. Reporters are credited in the advisory unless you ask not to be.

## Supported Versions

Releases are cut from `main` only. There are no maintenance branches and no
backports: a fix ships in the next release from `main`.

| Version                                                    | Supported                     |
| ---------------------------------------------------------- | ----------------------------- |
| Latest published release (`1.38.x` at the time of writing) | ✅                            |
| Anything older                                             | ❌ — upgrade before reporting |

Reproduce on the latest release before reporting. If you cannot upgrade, say so
in the report and describe what blocks it.

## Where the Interesting Bugs Are

tea-rags reads and parses whatever repository you point it at, then stores
derived payloads in Qdrant and hands search results back to an agent. That is a
larger attack surface than a typical CLI, and it is where a security report is
most useful:

- **Hostile repository content.** A source file, filename, or piece of git
  metadata that makes the chunker, a language parser, or an enrichment provider
  do something worse than fail — write outside the data directory, execute
  anything, or leak content between projects.
- **Payload or filter injection.** MCP tool parameters, or indexed content, that
  escape into Qdrant filters or collection names and reach data belonging to a
  different collection.
- **Secret exposure.** `OPENAI_API_KEY`, `COHERE_API_KEY`, `VOYAGE_API_KEY`, or
  `QDRANT_API_KEY` surfacing in logs, debug output, error hints, or the project
  registry at `~/.tea-rags/registry.json`.
- **Embedded Qdrant management.** tea-rags downloads the Qdrant binary from the
  `qdrant/qdrant` GitHub releases and runs it locally. Anything that lets a
  different binary be fetched, substituted, or executed belongs here.
- **HTTP transport.** The MCP HTTP transport serves at
  `http://localhost:<port>/mcp`. Unintended exposure or an escape from what that
  endpoint is supposed to reach counts.

## Out of Scope

- **Vulnerabilities in Qdrant, Ollama, or a cloud embedding provider.** Report
  those upstream. Do tell us if tea-rags's use of them makes something
  exploitable that otherwise would not be.
- **Anything that assumes the attacker already runs code as your user.**
  tea-rags is local-first and runs with your permissions by design.
- **Resource exhaustion from indexing a very large repository.** That is a
  performance bug — file it as a normal issue.
- **Prompt injection written into a repository's own text and repeated back by
  your agent.** Retrieval returns what the file contains; treat retrieved
  content as data, not instructions. A case where tea-rags itself amplifies it —
  repository content escaping into tool descriptions or server-side prompts — is
  in scope.
