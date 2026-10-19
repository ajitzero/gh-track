---
title: "03 — Decisions"
type: plan
status: active
updated: 2026-10-20
---

# 03 — Decisions

Decisions made during the initial design interview on 2026-10-19. Each entry records the choice, the alternatives rejected, and the consequence. Amend this file when a decision changes; do not rewrite history.

## Summary

| ID | Decision |
|---|---|
| D001 | Local files only, no database |
| D002 | One directory per run, ISO-8601 UTC run IDs |
| D003 | Bun as package manager; TypeScript compiled to `dist/`; Node >= 20 runtime; no Bun APIs |
| D004 | Unauthenticated by default; `--token` accepted but optional |
| D005 | Subjects: user followers + owned repositories, and single repositories |
| D006 | Store full raw payloads for every run inside the retention window |
| D007 | Rolling compaction, 30 days raw, minimal metric set, automatic after fetch |
| D008 | Diffs derived on demand and never persisted |
| D009 | No aggregates or rollups |
| D010 | TOML config in XDG; data in XDG |
| D011 | `@clack/prompts` for interaction, gated on TTY and format |
| D012 | `--format json` is a strict machine contract with stable exit codes |
| D013 | Hand-rolled command registry for help |
| D014 | No gzip in v1 |
| D015 | Docs are an Obsidian vault with relative links and a `type` field |
| D016 | Test runner uses quoted globs, not a directory argument |
| D017 | Interactive first-run setup for a missing watchlist |
| D018 | Dry-run baseline, explicit-subject resources, and cache persistence |
| D019 | Run writer, partial promotion, and resume semantics |

## D001 — Local files only

**Decision.** Snapshots, history, caches, and locks are plain JSON/NDJSON files under an XDG data directory. No database.

**Rejected.** SQLite (fast queries, but opaque, harder to inspect and back up, and a schema migration burden); a single append-only log (cheap appends, but poor browsability and risky partial writes).

**Consequence.** Queries are linear scans. At the expected scale (hundreds of repositories, a few runs per day, 30 days retained) this is irrelevant. Users can `jq`, `grep`, copy, and archive the data without the tool.

## D002 — One directory per run, ISO-8601 IDs

**Decision.** Each run is `runs/YYYY-MM-DDTHH-MM-SSZ/` with an ISO-8601 UTC id. Multiple runs per day are allowed. Temporary work happens in `runs/.tmp-<id>/` and is promoted by `rename()`.

**Rejected.** UUIDv7 or ULID (sortable and collision-free, but less human-readable for a data directory people inspect by hand); a single file per day (cannot hold multiple runs per day); timestamp plus random suffix (only needed for same-second collisions, which do not occur with second precision in practice).

**Consequence.** Lexicographic order equals chronological order. Same-second runs are possible in theory; if that ever happens, the second run errors rather than overwriting. Mitigation is a suffix, not a redesign.

## D003 — Bun, TypeScript, and Node compatibility

**Decision.** Author in TypeScript. Bun installs dependencies and runs source during development. `tsc` compiles to `dist/`. The published binary runs on Node >= 20. No `bun:*` imports anywhere in `src/` or `test/`.

**Rejected.** npm (slower; the user chose Bun); TypeScript with Node type stripping only (narrower Node compatibility); Bun-only APIs such as `bun:sqlite` (would make `npx` unusable); plain JavaScript (weaker models for manifests and diffs).

**Consequence.** One build step. Tests compile to `dist-test/` and run under `node --test`, so the test path exercises the same runtime as users get.

## D004 — Unauthenticated first

**Decision.** v1 works with no token. `--token` is accepted and, when present, sent as `Authorization`. An environment variable named by `defaults.token_env` (default `GH_TOKEN`) is read if `--token` is absent; setting it to `""` disables that. Tokens are never stored on disk or logged.

**Rejected.** Requiring a token (5,000 req/hour, but a setup barrier); a stored credential and keyring integration (scope and security work); shelling out to `gh auth token` (hidden dependency and surprising behavior).

**Consequence.** The default quota is 60 requests/hour per IP, shared with other processes. Request planning, ETag caching, partial runs, and resume are mandatory, not nice-to-haves. Private repositories remain out of scope even when a token is supplied.

## D005 — Subject types

**Decision.** Watch `user:<login>` (fetch `followers` and `repos`) and `repo:<owner>/<name>` (fetch `repo`). A user's repositories supply star and fork counts for every owned repository in one paginated list. There is no `user.profile` request.

**Rejected.** Tracking a user's starred list (the original framing, but the user clarified the goal is stars *on* owned repositories); tracking a profile endpoint (redundant — follower count is the length of the list); organization membership and everything-associated ingestion (rate-limit heavy and not requested); URL-driven subject parsing (more surface for little gain).

**Consequence.** Public accounts only without a token. Follower identity history exists only for accounts whose full follower list is fetched; large accounts cost one request per 100 followers.

## D006 — Full raw payloads

**Decision.** Store the complete API response for every run inside the retention window. Expand list responses into per-repository files while retaining the original pages.

**Rejected.** A curated field subset (smaller, but future questions would need a backfill GitHub cannot provide); content-addressed deduplication (elegant and space-efficient, but rejected because the user chose full raw every run and browsability by account/repository).

**Consequence.** Disk usage grows with repositories × runs. The 30-day window bounds it, and compaction bounds the long-term growth. The full payload means diffs can compare every scalar field, not just the three compacted metrics.

## D007 — Rolling compaction

**Decision.** Keep raw runs for 30 days by default. After a complete fetch, automatically compact eligible days into `history/` and prune their raw directories. The compacted line contains `stars`, `forks`, and `followers` only. The last complete run of a UTC day wins.

**Rejected.** Keeping everything forever (unbounded growth); gzip instead of compaction (smaller, but still unbounded and does not produce a queryable history); a wider metric set (deferred — see the consequence); compacting on a manual command only (the user chose automatic).

**Consequence.** Diffs older than the raw window are limited to stars, forks, and followers, and follower identities are unavailable. This is irreversible. Widening the history schema later only affects future days; past days cannot be backfilled. Revisit this before building the dashboard, which may want more metrics.

## D008 — Diffs on demand

**Decision.** `diff` reads stored runs or history each time it runs and writes nothing. Repository identity is the numeric `id`, with `full_name` as a fallback.

**Rejected.** Persisting computed diffs (duplicated data, invalidation problems, stale results); diffing only adjacent runs (too restrictive).

**Consequence.** Repeated diffs cost CPU but never disk. Renames are handled correctly as long as the id survives, which it does for public repositories.

## D009 — No aggregates

**Decision.** Report exact per-repository counts and per-account follower counts. Do not sum stars, compute totals, averages, or leaderboards.

**Rejected.** A "total stars" headline (explicitly declined by the user; it obscures per-repository movement).

**Consequence.** The dashboard, when it arrives, must present per-item values unless a future decision reverses this.

## D010 — XDG and TOML

**Decision.** Data in `$XDG_DATA_HOME/gh-track`, config in `$XDG_CONFIG_HOME/gh-track/config.toml`, both overridable by flags. Config is TOML.

**Rejected.** JSON config (the user asked for TOML); a config file in the repository (couples machine-specific watchlists to the codebase); environment-variable-only configuration (poor for lists).

**Consequence.** Runtime data is never committed. The repo stays clean. Windows support is best effort via `%LOCALAPPDATA%` and `%APPDATA%`.

## D011 — Clack prompts, strictly gated

**Decision.** Use `@clack/prompts` for the watchlist flows, confirmations, and progress. Prompts run only when both stdin and stdout are TTYs, the format is `table`, and `--yes` is absent. JSON mode is always non-interactive.

**Rejected.** A hand-rolled prompt library (more code, worse UX); always-interactive commands (unusable from scripts and agents); prompting in JSON mode (would corrupt the output contract).

**Consequence.** Non-interactive callers must pass complete arguments and `--yes` where required, or receive a usage error that shows the exact invocation.

## D012 — Strict JSON contract

**Decision.** `--format json` emits one document on stdout, no ANSI or progress. Errors go to stderr as JSON. Exit codes: `0` success, `1` runtime, `2` usage/config, `3` partial fetch, `130` interrupted.

**Rejected.** Human-oriented output only (blocks jq and AI agents); JSON on stdout mixed with logs (unparseable); always exiting `0` (hides partial runs).

**Consequence.** Every command's renderer is separate from its logic, and JSON purity is a test requirement.

## D013 — Hand-rolled help registry

**Decision.** One registry of command nodes drives root, command, and subcommand help, including an optional `examples` array that renders only when non-empty.

**Rejected.** Commander or yargs (more capability than needed, and less control over output and JSON-mode behavior); per-command hard-coded help strings (drift and duplication).

**Consequence.** Roughly 100 lines of renderer code. Adding a command means adding one registry node.

## D014 — No gzip in v1

**Decision.** Raw run files are plain JSON. Compression is deferred.

**Rejected.** Gzip by default (extra read path, harder inspection, and the 30-day window already bounds size).

**Consequence.** Disk usage is larger for 30 days, then drops sharply after compaction. A future `--gzip` can be added without changing the manifest contract.

## D015 — Docs as an Obsidian vault

**Decision.** `docs/` is the vault root. Documents use relative Markdown links (which also render on GitHub), frontmatter with `title`, `type` (`core` or `plan`), `status`, and `updated`. No tags. `.obsidian/` is tracked. `docs/plans/00_PLAN.md` is folder metadata; plans start at `01_`.

**Rejected.** Wikilinks (do not render on GitHub); tags (optional in Obsidian, and the user preferred a `type` field); ignoring `.obsidian/` (the user wants vault settings tracked).

**Consequence.** The docs work in Obsidian and in a plain Git browser. Numbering is stable and never reused.

## D016 — Test runner globs

**Decision.** `bun run test` compiles with `tsc -p tsconfig.test.json` and then runs `node --test "dist-test/test/**/*.test.js"`. `test:unit` uses the matching `test/unit` glob. The glob is quoted so Node's test runner expands it.

**Rejected.** `node --test dist-test/test` (the original plan): Node no longer expands a directory argument for `--test`, so on Node 21+ it tries to load `dist-test/test` as a module and fails. Relying on shell glob expansion instead (unreliable across shells, and `**` needs globstar).

**Consequence.** The scripts work unchanged on Node >= 20 (where the runner also accepts glob patterns) and Node 24. `02_IMPLEMENTATION.md` now shows the globs.

## D017 — Interactive first-run setup

**Status.** Planned, post-v1. Specified by milestone M7 in [02_IMPLEMENTATION.md](02_IMPLEMENTATION.md); not implemented yet.

**Decision.** When a command that requires the watchlist runs interactively with no config, offer to create one instead of failing immediately. Reuse the `watch add` flow as the wizard: type picker, name input, and — for users — a resource multi-select (`followers`, `repos`) with both preselected and at least one required. `repo` skips the resource step. After the wizard, the original command continues. The wizard runs only under the existing gate (both TTYs, `table`, no `--yes`); otherwise the command fails exactly as today with `config_missing`, exit `2`, with the message naming the non-interactive invocation. Declining the wizard does not count as success: the original command still fails with `config_missing`. `Ctrl-C` exits `130`. An existing-but-empty watchlist is not a trigger.

**Rejected.** A separate `gh-track init` command (extra surface to discover, and it duplicates `watch add`); silently creating an empty config on first read (still leaves the user with nothing and hides the real problem); prompting in `--format json` or non-TTY runs (would break the machine contract and hang scripts); treating a declined wizard as a successful no-op (contradicts the documented failure contract for watchlist-requiring commands); offering setup for an empty configured watchlist (a deliberate state, already handled by `empty_watchlist`).

**Consequence.** New users get a working path from `gh-track watch ls` or `gh-track fetch` on a fresh machine without reading the docs. Every existing non-interactive behavior, exit code, and JSON output stays unchanged. `watch add` with no arguments becomes the canonical onboarding flow, so it must keep working if the first-run trigger is later removed.

## D018 — Dry-run baseline, subject resources, and cache persistence

**Context.** M2 implements the GitHub client, ETag and rate-limit caches, the resource URL builders, and `fetch --dry-run`. The spec fixes the dry-run JSON shape (§5.8) but leaves several operational details open; these are the choices made.

**Decision.**

1. **Quota baseline.** With no observed quota, a run assumes the full default ceiling (60 unauthenticated, 5,000 with a token) and reports `remaining - 2`. A cached `state/limits.json` entry is used only while its `resetAt` is in the future; once it has passed, the window is treated as fresh and the full `limit` applies. `--max-requests` may only lower the derived cap, and clamping is reported as a warning on stderr.
2. **Explicit-subject resources.** `fetch <subject>` reuses the resources configured for that subject when it is already in the watchlist; otherwise it uses the defaults (`followers,repos` for users, `repo` for repositories). Explicit subjects are still never added to the config.
3. **Page estimation.** `--dry-run` estimates pagination from the ETag cache (the highest `page=N` seen per resource) and marks each planned request `conditional` when a validator exists for its URL. The true page count is unknowable without spending quota; a real fetch follows `Link` headers dynamically.
4. **Cache persistence.** ETag and rate-limit persistence lives in `store/state.ts`; `src/github/*` stays free of filesystem imports (handoff note 3), keeping the client and its caches injectable and offline-testable.

**Rejected.** Assuming zero remaining quota when nothing is observed (`--dry-run` would report a useless cap of 0); ignoring `resetAt` (a stale entry would under-report the budget for up to an hour); always using default resources for explicit subjects (a `--resources followers` watch would silently refetch repositories); trusting the cached page count for real runs (the cache only feeds the dry-run estimate); letting `github/*` read the state files directly (couples HTTP code to the storage layout).

**Consequence.** `--dry-run` is meaningful on a fresh machine and writes nothing. Real runs remain the source of truth for pagination, and `store/state.ts` is the single owner of the advisory caches.

## D019 — Run writer, partial promotion, and resume semantics

**Context.** M3 implements `store/runWriter.ts`, `store/manifest.ts`, `store/lock.ts`, the live `fetch` path, `runs ls|show|paths`, and `watch ls` last-run summaries. The spec fixes the run layout and JSON contracts; these are the operational choices it leaves open.

**Decision.**

1. **Atomic promotion.** A fresh run writes every payload and the final manifest into `runs/.tmp-<id>/`, then `rename()`s the directory to `runs/<id>/`. The manifest is written once, immediately before promotion, so a promoted run always has a complete manifest. A same-second id collision is an `io_error`, never an overwrite.
2. **Partial triggers.** A run is promoted as `partial` when the request cap is reached, the primary rate limit is exhausted, the process is interrupted, or any request ultimately fails. Unstarted and failed requests are deduplicated into `pending`; a `404` is recorded in `errors` and does not make the run partial.
3. **Exit codes.** `complete` exits `0`, `partial` exits `3`, and an interrupted run exits `130` after promoting. `resumeAfter` is set only for rate-limit stops.
4. **Resume.** `--resume [<run-id>]` opens the newest partial run (or the named one) in place, refetches only `pending` URLs, ignores subject arguments with a warning, and refuses complete runs and `--dry-run`. Error entries for a URL are cleared when that URL later succeeds.
5. **`304` copies forward.** A not-modified response copies the previous payload into the new run, so every promoted run is self-contained even after older runs are pruned. The manifest entry keeps `sourceRun`/`sourcePath` for provenance.
6. **Locking.** One `pid` lock in `locks/fetch.lock` covers the whole live fetch, including cache writes. A dead pid is reclaimed; a live pid yields `locked` (exit `1`). `--dry-run` takes no lock. Leftover `.tmp-*` directories are removed by the next live fetch while it holds the lock.
7. **Last-run lookup.** `watch ls` scans manifests newest-first, compares subjects case-insensitively, and ignores `failed` runs, so a subject that has never completed or partially fetched reports `null`.

**Rejected.** Writing the manifest after every request (more atomicity for a hard kill, but much more I/O and no benefit once the next fetch cleans `.tmp-*`); keeping `<id>-2` suffixes for same-second runs (the collision is rare and an explicit error is honest); resolving `304` from a run that may later be pruned (breaks the self-contained invariant); making `404` a partial-run trigger (a missing repository should not force a resume); storing last-run data in config (derived state belongs with the runs).

**Consequence.** Completed runs are immutable and self-contained, hard kills leave only temp garbage, and resuming never spends quota on requests that already succeeded. M4 can prune raw runs without breaking conditional responses from surviving runs.

## Open questions

1. **Compaction width.** The dashboard may want metrics beyond stars, forks, and followers. Widening the history line is easy but cannot backfill past days. Decide before the dashboard consumes history.
2. **Token features.** `--token` exists, but private-repository support, per-subject authentication, and keyring storage are deferred.
3. **Same-second runs.** Currently an error. If it ever matters, add a short suffix to the run id.
4. **Starred-list tracking.** Rejected for v1; revisit only if the original use case resurfaces.

## Related

- [Goal](../00_GOAL.md)
- [Architecture](../01_ARCHITECTURE.md)
- [Spec](01_SPEC.md)
- [Implementation](02_IMPLEMENTATION.md)
