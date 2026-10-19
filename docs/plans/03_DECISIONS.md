---
title: "03 — Decisions"
type: plan
status: active
updated: 2026-10-19
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
