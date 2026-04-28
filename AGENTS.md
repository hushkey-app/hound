# Agents

Project-scoped agents live in [.claude/agents/](.claude/agents/) and are auto-loaded by Claude Code in this repo. Use them via the `Agent` tool with `subagent_type: <name>`.

## Available agents

### [hound-pr-reviewer](.claude/agents/hound-pr-reviewer.md)
Reviews PRs against `mirairoad/hound`. Terse, signal-heavy output: BLOCKER/MAJOR/MINOR/NIT findings, file:line refs, no fluff.

**Use when:** user pastes a `github.com/mirairoad/hound/pull/N` URL, says "review this PR/branch", or wants pre-merge feedback.

**Notes:**
- `gh` CLI is **not installed** — agent uses `WebFetch` on `patch-diff.githubusercontent.com/raw/mirairoad/hound/pull/N.diff`.
- Read-only. Never pushes, merges, or comments on GitHub.
- Knows the landmines: Promise.race without AbortSignal, middleware silent-success, handlerKey mismatches, Streams nostalgia, singleton bleed in tests.

### [hound-codebase-expert](.claude/agents/hound-codebase-expert.md)
Discovery specialist for the hound codebase. Answers "how does X work" / "where is Y" with precise file:line evidence — no summaries, no speculation.

**Use when:** architecture questions, tracing job lifecycle, locating implementations, before designing a non-trivial change.

**Knows:**
- Architecture: `Hound` → `Processor` → `Consumer` + `QueueStore` (ZADD, not Streams) + `Reaper` + `HoundManagement`.
- Job lifecycle: deterministic jobId (FNV-1a), monotonic ZADD score, visibility-deadline crash recovery.
- Backend parity rule: Redis + InMemoryStorage + Deno KV.
- Test convention: `withHound` helper, `Hound._reset()` between tests, never mock Redis.

## Conventions

- Local dir is `/Users/leo/Private/typescript/remq` (legacy name); the project is **hound**, not redismq.
- Commit prefix: `HND-XXXXX`.
- Public package: `jsr:@hushkey/hound`.
- Don't reintroduce Redis Streams — the ZADD rewrite was deliberate.
