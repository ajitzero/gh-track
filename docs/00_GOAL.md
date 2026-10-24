`gh-track` is a local-first CLI that snapshots public GitHub metadata on demand, keeps a durable history, and shows exactly what changed between any two runs.

## The problem

The GitHub API is point-in-time. A repository tells you how many stars it has _now_; it does not tell you how many it had yesterday, who starred it, or which followers an account lost overnight. The web UI hides most of this too. If you want a delta, you have to record the state yourself and compare later.

The practical questions this project answers:

- Which of my repositories gained or lost stars since the last run, by exactly how many?
- Which accounts started or stopped following a given user?
- Which repositories did an account create, delete, rename, or archive?
- Is a project I care about still growing?

## What v1 does

1. Reads a TOML config listing watched **subjects** (accounts and repositories).
2. Fetches their public REST resources — followers, owned repositories, and single repositories — without requiring a token.
3. Writes one immutable, timestamped **run** directory containing the raw responses and a manifest.
4. Tolerates the unauthenticated rate limit by planning requests, caching with ETags, and producing resumable partial runs.
5. Compacts runs older than the retention window into a compact per-day history, then prunes the raw data.
6. Derives **diffs** on demand from stored runs: exact per-repo field deltas and named follower additions/removals.
7. Emits either human tables or a single machine-readable JSON document, so scripts and AI agents can consume it with `jq`.

## Who it is for

One operator. The primary use case is watching your own account (its repositories and followers) plus any number of arbitrary public accounts and repositories. Multiple accounts are supported by listing multiple subjects; there is no multi-tenant model, server, or sync.

## Success criteria

- A fresh checkout fetches a small watchlist with **no token at all**.
- Every run is written atomically and can be resumed after a rate-limit stop without refetching completed pages.
- `gh-track diff` reports, per repository, the exact before/after values and deltas for star and fork counts, plus named follower additions and removals.
- `--format json` output is a single valid JSON document with no ANSI, spinner, or prompt contamination.
- `gh-track watch ls` shows what is configured and the status of its last run.
- `--help` works at the root, command, and subcommand levels, with room for examples.
- Runs older than 30 days are compacted automatically and their raw data is pruned only after compaction succeeds.

## Non-goals for v1

- Full-screen TUI or alternate-screen app. The dashboard is a rendered table (see [04_DASHBOARD.md](04_DASHBOARD.md)).
- Scheduling: no cron, daemon, or background worker. You run it.
- Required authentication, stored credentials, or keyring integration.
- Private repositories, organization membership, traffic/clone/view data.
- Tracking a user's starred list.
- Aggregates and rollups: no total-star sums, no leaderboards.
- Cross-machine sync, a server, or a database.
- Historical backfill: GitHub cannot provide star counts for past dates. History starts when you start running the tool.

## Principles

1. **Local-first.** Plain files in XDG directories. You can inspect, copy, and archive the data without the tool.
2. **Immutable runs.** A finished snapshot is never mutated. Corrections happen as new runs.
3. **On-demand.** The tool assumes nothing about how often it runs; multiple runs per day are normal.
4. **No-token-first.** Public data works unauthenticated. A token is an optional upgrade for quota and private repos.
5. **Raw fidelity inside the retention window.** Store the full response, not a curated subset, so future questions do not require a backfill.
6. **Derived data is cheap to recompute.** Diffs are not stored. Compaction is the one exception, because raw data is deleted.
7. **Machine-readable is a contract, not an afterthought.** JSON stdout, stable exit codes, no interactive behavior in non-TTY use.
8. **Minimal dependencies.** Two runtime packages at most.

## Reading order

1. [Architecture](01_ARCHITECTURE.md) — how the system is put together.
2. [Spec](02_SPEC.md) — exact command, config, and output contracts.
3. [Decisions](03_DECISIONS.md) — reasoning, rejected alternatives, plan history, and open backlog.
4. [Dashboard](04_DASHBOARD.md) — dashboard design and observation model.
