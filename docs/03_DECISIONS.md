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
| D020 | Compaction marker, prune scope, and export rows |
| D021 | Diff point resolution, source limits, and subject filtering |
| D022 | v1 hardening: JSON purity matrix, failed-response quotas, watch table |
| D023 | Dashboard: narrow metrics, per-subject observations, full-snapshot views |
| D024 | Flat docs and harness-owned plans |
| D025 | `dashboard add`: composite setup and repository browsing |
| D026 | Review hardening: shared helpers, origin checks, JSON warnings |
| D027 | Compact dashboard hierarchy for tracked owners |
| D028 | Compact metric widths track actual values |

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

**Consequence.** Diffs older than the raw window are limited to stars, forks, and followers, and follower identities are unavailable. This is irreversible. Widening the history schema later only affects future days; past days cannot be backfilled. [D023](#d023--dashboard-narrow-metrics-per-subject-observations-full-snapshot-views) resolves the dashboard question by using only those three metrics, so the compacted shape stays narrow.

## D008 — Diffs on demand

**Decision.** `diff` reads stored runs or history each time it runs and writes nothing. Repository identity is the numeric `id`, with `full_name` as a fallback.

**Rejected.** Persisting computed diffs (duplicated data, invalidation problems, stale results); diffing only adjacent runs (too restrictive).

**Consequence.** Repeated diffs cost CPU but never disk. Renames are handled correctly as long as the id survives, which it does for public repositories.

## D009 — No aggregates

**Decision.** Report exact per-repository counts and per-account follower counts. Do not sum stars, compute totals, averages, or leaderboards.

**Rejected.** A "total stars" headline (explicitly declined by the user; it obscures per-repository movement).

**Consequence.** The dashboard presents per-item values and never adds a total, average, or leaderboard (D023).

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

**Amended 2026-10-20.** The `docs/plans/` layout and the `plan` type are superseded by [D024](#d024--flat-docs-and-harness-owned-plans). The Obsidian and relative-link rules still apply. Frontmatter and H1 headings were removed from all docs on 2026-10-20; see D024.

**Rejected.** Wikilinks (do not render on GitHub); tags (optional in Obsidian, and the user preferred a `type` field); ignoring `.obsidian/` (the user wants vault settings tracked).

**Consequence.** The docs work in Obsidian and in a plain Git browser. Numbering is stable and never reused.

## D016 — Test runner globs

**Decision.** `bun run test` compiles with `tsc -p tsconfig.test.json` and then runs `node --test "dist-test/test/**/*.test.js"`. `test:unit` uses the matching `test/unit` glob. The glob is quoted so Node's test runner expands it.

**Rejected.** `node --test dist-test/test` (the original plan): Node no longer expands a directory argument for `--test`, so on Node 21+ it tries to load `dist-test/test` as a module and fails. Relying on shell glob expansion instead (unreliable across shells, and `**` needs globstar).

**Consequence.** The scripts work unchanged on Node >= 20 (where the runner also accepts glob patterns) and Node 24. The package scripts use the quoted globs.

## D017 — Interactive first-run setup

**Status.** Planned, post-v1. Tracked in [§ Open backlog](#open-backlog); not implemented yet.

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

## D020 — Compaction marker, prune scope, and export rows

**Context.** M4 implements `history.ts`, `compact.ts`, `prune.ts`, automatic post-fetch compaction, and `export`. The spec defines eligible days, history shapes, and the `compact`/`export` JSON contracts but leaves the bookkeeping between compaction and pruning, the export row shape, and locking details open.

**Decision.**

1. **Compacted-day marker.** `state/compacted.json` holds `{ "days": ["YYYY-MM-DD", ...] }`, sorted and unique. It is written after the day's history rows and before pruning. Pruning reads the marker and deletes only runs whose day is listed, which is what keeps partial-only days safe.
2. **Day replacement, not blind append.** For each compacted day, rows for that date are removed from every history file before the chosen run's rows are written. The last complete run of the day is therefore authoritative: repositories or accounts absent from it do not keep stale lines for that date. Rewriting the same day is idempotent.
3. **Prune scope.** Pruning considers only `runs/<valid-run-id>` directories and re-checks that each resolved path is directly under `runs/` before a recursive delete. `.tmp-*` and malformed directory names are ignored. ETag cache entries whose `sourceRun` is pruned are removed so a later conditional request cannot fail to resolve a `304`.
4. **Export rows.** JSON and JSONL use one row shape aligned with the CSV columns: `{date, kind, subject, stars?, forks?, followers?}`. Repository rows include `stars`/`forks`; account rows include `followers`; unused fields are absent. Rows are sorted by date, then `kind`, then case-insensitive subject.
5. **Locking.** `compact` takes the same exclusive fetch lock for real runs, because it writes history and deletes runs. `compact --dry-run` takes no lock and writes nothing. `export` is read-only and lock-free; atomic file writes and complete NDJSON lines make concurrent reads safe.
6. **Automatic compaction.** A complete fetch compacts with `--keep-raw-days` or `config.defaults.raw_retention_days`, then reports `{compactedDays, prunedRuns}`. Partial runs never compact, and `--no-compact` skips both steps. A compaction error propagates after the run is already promoted, so the snapshot is never lost.

**Rejected.** Marking days by the presence of history rows (cannot distinguish a day with no metrics from an uncompacted day); appending without removing the date (stale rows after a late complete run); pruning based only on age (would delete partial-only days and runs whose history was never written); a lock file for `--dry-run` (violates "writes nothing"); treating `export --format jsonl` as the JSON output contract (mixed machine contracts and made ANSI suppression ambiguous).

**Consequence.** Pruning is reversible only from history, as D007 intends. A corrupt or deleted `compacted.json` is safe: compaction re-runs before any further pruning. Export is deterministic and directly consumable by `jq`/spreadsheets without post-processing.

## D021 — Diff point resolution, source limits, and subject filtering

**Context.** M5 adds `diff` over stored raw runs and compacted history. The spec defines the reference forms, the source limits, and the JSON shape, but not how compacted days participate in reference resolution, how a missing scalar key is represented, or how `--subject` treats a user's owned repositories.

**Decision.**

1. **Comparable points.** Every complete raw run is a point. A day with compacted history is also a point, unless a complete raw run for that day still exists; raw data always wins because it carries ids and follower identities. Points are ordered by UTC day and then run id. `latest` is the last point, `previous` is the point immediately before the resolved `--to`, and a day or relative offset (`-1y`) is the last point on or before that day. A start bound older than every point snaps forward to the oldest point. At least two points are required.
2. **Run ids must still exist.** A run-id reference resolves only to a complete raw run on disk. A pruned run id yields `run_not_found` rather than silently substituting the day's history, because history stores only the day's chosen complete run. Date and keyword references may resolve to compacted days.
3. **Compacted endpoints.** A compacted point reports the UTC date as `id` and `null` as `finishedAt`; the exact finish time was not retained. `source` is `raw` when both points are raw, `compacted` when both are compacted, and `mixed` otherwise.
4. **Field limits.** Under `compacted` and `mixed`, repository fields are restricted to `stargazers_count` and `forks_count`, and follower results use counts with `added: null`, `removed: null`, and `identitiesAvailable: false`. Any change touching history therefore loses ids, renames, other scalar fields, and follower identities.
5. **Repository matching.** Numeric `id` is authoritative; `full_name` is consulted only when an id is unavailable on one side. This makes a raw rename one `renamed` entry, while a rename across compacted history appears as an add plus a remove because history has no ids. All changed scalar fields are reported, including keys present on only one side; a missing side is represented as `null`, while an explicit `null` remains a value. Added, removed, and rename-only entries carry `fields: {}`.
6. **Follower matching.** Raw followers are sets keyed by lowercased login, with display casing and numeric id taken from the newer side. Additions and removals are sorted by lowercased login. When either side is compacted, equal counts produce no entry because churn cannot be observed; differing counts produce a count-only entry.
7. **Subject filtering.** Filtering is applied after the diff. `repo:<owner/name>` matches that repository, including its previous name when renamed. `user:<login>` matches that account's follower diff and every repository whose `full_name` owner is that login. This owner-prefix rule is the only attribution available in compacted history, so raw and history filtering behave identically.
8. **Read-only.** `diff` takes no lock and writes nothing, including `state/` and locks. Rendering happens in the command, following the existing `compact`/`export` pattern.

**Rejected.** Treating a compacted day as a synthetic run id (users cannot name it); resolving a pruned run id from its day (would substitute a different run and hide the data loss); persisting computed diffs (D008); restricting raw field comparisons to the three compacted metrics (defeats D006's full-payload purpose); matching repositories by name first (breaks renames); omitting scalar fields present on only one side (defeats the full-payload purpose); filtering before diffing (a filtered-out repository could hide a rename needed for attribution).

**Consequence.** `diff` is deterministic across raw and compacted data and honestly declares its source. Users who need rename or identity data must run diffs before the retention window prunes the runs, or extend retention.

## D022 — v1 hardening: JSON purity matrix, failed-response quotas, watch table

**Context.** M6 is the acceptance pass for v1. It adds no commands, but closes gaps between the spec and the implementation found by running every command against a fake TTY and by simulating a primary rate-limit stop.

**Decision.**

1. **One JSON purity matrix.** A single integration test runs `watch add`, `watch ls`, `watch rm`, `fetch`, `fetch --dry-run`, `runs ls`, `runs show`, `runs paths`, `diff`, `compact`, and `export` with stdin, stdout, and stderr all marked as TTYs and `--format json`. Each command must leave stderr empty, emit one parseable document with a trailing newline and no ANSI, and pass the normal command assertions. A companion test checks that JSON errors leave stdout empty and put one parseable error document on stderr.
2. **Quota headers survive failed responses.** `GitHubClient` records the parsed rate-limit headers from every response before handling its status. `fetch` persists those headers when a request throws, so a primary-limit stop writes `state/limits.json` with `remaining: 0` and the reset time. Without this, a resume immediately sees the previous (stale) quota and can hit the same limit again.
3. **Watch table shows the full last-run summary.** `watch ls` renders the run id, status, finish time, repository count, and follower count, matching spec §2.2. Its JSON shape is unchanged.
4. **Locking text follows the implementation.** Spec §11 now says `compact` takes the exclusive fetch lock and read-only commands take no lock, matching D020.
5. **The unimplemented-command fallback is gone.** Every command in the registry is dispatched; an unknown dispatch is an internal error rather than a milestone placeholder.

**Rejected.** Ad-hoc JSON checks in each command test (easy to miss a new command); persisting quota only from successful responses (loses the exact response that caused the stop); keeping the table to the run id (under-reports the documented summary); adding a lock to `runs`/`diff` (they read atomically written files and would block fetches without benefit).

**Consequence.** JSON purity and rate-limit resume are enforced by the offline suite on every change. A primary-limit stop is now self-describing in state, and the human watchlist view matches the documented summary.

## D023 — Dashboard: narrow metrics, per-subject observations, full-snapshot views

**Context.** [04_DASHBOARD.md](04_DASHBOARD.md) was deferred during v1 and left four open questions: whether to widen compaction, whether selections apply retroactively, what to show when no selection exists, and whether per-subject metrics or named views are the right model. The dashboard is a read-only value view over the same data as `diff`.

**Decision.**

1. **Narrow metrics.** The dashboard exposes only `stars`, `forks`, and `followers`. These are exactly the compacted fields, so every row is comparable across the full retained timeline. The history schema is not widened. This resolves the irreversible D007 question in favor of the existing compacted shape.
2. **Per-subject observations.** Each row builds its own series from complete raw runs and compacted history. Raw wins for a day with both. `--to` is an upper bound per subject (`latest`, `YYYY-MM-DD`, or a complete run id); `--from` defaults to the observation immediately before that subject's `to` observation. A subject that was not fetched in the latest run therefore keeps its value and its own baseline. Row `source` is `raw`, `compacted`, `mixed`, or `null`.
3. **Tracking plus full-snapshot views.** `[tracking."<subject>"]` holds the unnamed default selection with per-subject metrics. `[views."<name>"]` holds a complete snapshot: `items`, `layout`, and `from`/`to`. A view is authoritative and does not inherit metrics from `[tracking]`, so what was saved is what renders. CLI flags override the view. Views live at the config root so control tables do not nest inside subject-keyed tables.
4. **Two layouts, one palette.** `compact` is the default: one entity block with a `METRICS` column and a `SINCE` column, using one line per selected metric. `columns` groups repositories and accounts into sections with one column per selected metric. In compact, metric values are right-aligned within the block while the `METRICS` header stays at its left edge, with a variable-width label, a count field of at least five characters, a one-character compacted-marker slot, and a delta field of at least five characters including parentheses. Values widen rather than truncate; a missing baseline leaves the delta slot blank, and a subject with no observation renders one `—`. Repositories are bold light blue (`94`), accounts bold purple (`95`), values bold, deltas green/red, zero deltas and provenance dim. Names are unprefixed in both layouts; kind is carried by color. Compacted values carry a literal dim `~`, which survives `NO_COLOR`. `SINCE` is always present because per-subject baselines differ.
5. **Never-fetched subjects are visible.** A selected subject with no observations renders `—` and resolves to `null` fields in JSON. Silently hiding it would make a selected subject easy to forget.
6. **Setup is interactive, rendering is not.** `dashboard` with no selection and an open prompt gate offers a clack picker, saves `[tracking]`, then renders. `dashboard add` extends or edits the selection, `track edit` replaces it, and `track view save` reuses the picker. With the gate closed, `dashboard` renders all configured subjects with defaults and never prompts. `--format json` is always deterministic.
7. **No totals.** D009 still applies. The dashboard has no sum, average, or leaderboard footer.
8. **`--from` / `--to` only.** `--since` from the draft is dropped; the dashboard reuses diff reference forms rather than inventing a second range syntax.
9. **Styled table cells.** `output/table.ts` accepts a cell whose width is measured from plain text and which is painted at render time, supports per-column alignment, and trims trailing whitespace. Existing string cells are unchanged.
10. **`watch rm` cleans references.** Removing a subject also removes its `[tracking]` entry and its items from every view; a view left empty is removed with a warning.

**Rejected.** Widening history now (the user only wants the three metrics; widening would change export CSV columns and diff's compacted field limit for no benefit); global diff points (subjects are fetched independently, so a global point would blank out or distort stale rows); view overlays on `[tracking]` (ambiguous precedence and two places to look); sparse single-table metric columns (unreadable when account and repository metrics differ); cyan-only provenance (the user asked for light blue and purple; using them for kind leaves `~` as the honest provenance marker); hiding never-fetched subjects (silent gaps); prompting from `dashboard --format json` or non-TTY runs (breaks the machine contract); totals (D009); a second date syntax (`--since`).

**Consequence.** The dashboard needs no new storage and no new dependencies. Every value is available for the entire timeline. Diffs remain global and unchanged; only the dashboard resolves observations per subject. A saved view is reproducible from config alone, and a first-run user reaches a rendered dashboard through the same clack-based flow as the rest of the tool.

## D024 — Flat docs and harness-owned plans

**Context.** `docs/plans/` mixed stable contracts (spec, decisions, dashboard design) with working plans (milestones and progress). The coding harness already provides a plan store, so keeping a second copy in the repository duplicated the workflow and left completed plans to rot.

**Decision.**

1. **Flat docs, no frontmatter or H1.** `docs/` holds numbered, lasting documents only: goal, architecture, spec, decisions, and dashboard. Documents have no YAML frontmatter and no H1 heading: the filename carries the title, and git tracks dates. `type`, `status`, and `updated` are retired.
2. **No plans folder.** `docs/plans/` is removed. `00_PLAN.md` (folder rules) and `02_IMPLEMENTATION.md` (milestones and progress) are retired; their durable content moved into this document and `AGENT.md`.
3. **Harness-owned active plans.** Agents write plan and scratch files only to the plan directory provided by their harness (OpenCode: `~/.opencode/plan`; the equivalent for Claude, Hermes, or another agent). These files are never committed.
4. **One durable record.** Completed plans, their achievements, and unfinished work live in § Plan history and § Open backlog in this file. A plan is recorded when it lands, not while it is being written.
5. **Spec and dashboard stay.** `01_SPEC.md` and `04_DASHBOARD.md` are contracts, not plans; they move to `docs/02_SPEC.md` and `docs/04_DASHBOARD.md`.

**Rejected.** Keeping `docs/plans/` alongside harness plans (two sources of truth, and the folder inevitably accumulates stale status); a separate `WORKLOG.md` (one more top-level file when the decision log already owns durable history); deleting the spec and dashboard docs (they hold the CLI/JSON contract and the dashboard design, which the architecture intentionally does not duplicate); rewriting D015 in place (the decision log records changes, it does not erase them); YAML frontmatter or an H1 heading (every field was the filename, always the same, or already tracked by git).

**Consequence.** The repository contains documentation, not work-in-progress plans. A fresh agent reads `AGENT.md`, uses its own plan tool, and records the outcome here. The full pre-restructure plan text remains in git history at `3deedbb`.

## D025 — `dashboard add`: composite setup, repository browsing

**Context.** `dashboard --setup` was the only way to re-run setup after the first run, but it expressed a flag rather than an intent, and it replaced the picker rather than adding to it. Adding a subject still required `watch add` plus `track set`/`track edit`, and selecting several repositories from one owner meant typing every full name. M7 (a general first-run wizard) remains separate and deferred.

**Decision.**

1. **`dashboard add` replaces `--setup` and is additive.** It appends missing subjects to `[[subjects]]` and sets their `[tracking]` entries. Explicit forms (`add user <login>`, `add repo <owner/name>`, `add <subject>`) are complete non-interactive commands; bare `add` runs a picker. Existing subject resources are preserved unless `--resources` is supplied.
2. **Repository browsing.** `add repo <owner>` and the interactive repository path list `GET /users/{owner}/repos`, paginated and sorted by updated, with a multi-select and a per-repository metrics prompt. `owner/name` remains a direct add. Already-tracked repositories are marked, not preselected.
3. **One save, no confirmation.** Config is written atomically after all prompts; cancelling or `Ctrl-C` writes nothing. Saved views are untouched.
4. **Token parity with fetch.** Listing resolves `--token`, then the env var named by `defaults.token_env`. On `403`, `404`, network failure, or an empty list it warns and asks for `owner/name` manually.
5. **Selection management stays under `track`.** `track edit/set/rm/ls/view` keep their semantics. `dashboard add` is the only new management surface.

**Rejected.** Keeping `--setup` as an alias (two entry points with different scopes: the flag forced a picker, add is additive); making `dashboard add` tracking-only (forces a hidden second command on a fresh install); auto-watching without preserving existing resources (silently changes fetch cost); prompting for metrics on explicit forms (breaks the complete-command contract); filtering already-tracked repositories out of the listing (hides state); preselecting them (accidental metric re-prompts).

**Consequence.** A fresh install reaches a populated dashboard with one command. Scripts using `--setup` must migrate to `dashboard add`; the error names the replacement. The dashboard still writes config only through the first-run picker and `dashboard add`.

## D026 — Review hardening: shared helpers, origin checks, JSON warnings

**Context.** A review of the post-M8.1 tree found duplicated date, guard, metric, reference, and CLI-error logic spread across commands and stores, plus three gaps around the GitHub client: redirects could leave the configured origin, a refused `Link` URL was queued forever, and the request timeout stopped at the response headers. It also surfaced undocumented behavior changes (JSON-mode warnings, the view-name length cap, and `track view save` layout defaults) and a conflict with D022's empty-stderr test contract.

**Decision.**

1. **One implementation per cross-cutting rule.** `date.ts`, `guards.ts`, `metrics.ts`, `refs.ts`, `cli-args.ts`, and `result.ts` own UTC-day helpers, runtime guards, metric parsing/order, reference classification, CLI argument errors, and command result helpers. `cli.ts` dispatches through one runner table. Stores and commands import these instead of keeping local copies.
2. **Origin is enforced end to end.** The client refuses a request URL outside the configured API origin, refuses a redirect whose final URL leaves that origin, and attaches the token only to same-origin requests. A refused URL is recorded as a subject error, fails the run (`partial`), and is excluded from `pending`; a resume never retries it.
3. **The timeout covers the response body.** The abort timer stays attached through `response.text()`. A body timeout is a retryable network error, like a header timeout. An unresolvable `304` drops the validator and retries unconditionally once, subject to the request cap.
4. **CLI edge cases are explicit.** `--limit` is valid only for `runs ls`; `export` rejects `--from` later than `--to`; `help bogus` and `bogus --help` return the same `Unknown command` error with usage.
5. **Warnings are allowed on stderr in JSON mode.** Spec §6 defines stdout as the single result document and stderr as progress, warnings, diagnostics, and errors. `watch rm` now emits its removal warnings in JSON mode too. This amends D022 §1: the JSON purity matrix asserts one clean document on stdout, not an empty stderr.
6. **Configuration tolerances are documented.** View names have no length cap; `[a-z0-9][a-z0-9_-]*` is the only constraint. `track view save` without `--layout` prompts for a layout and preserves an existing view's layout, matching spec §2.9's "supplying a flag skips the matching prompt".
7. **Calendar days are validated strictly.** Every `YYYY-MM-DD` check rejects impossible dates, including rows read from existing history files.

**Rejected.** Keeping per-command error strings (they drifted); suppressing JSON-mode warnings to satisfy D022 literally (hides dashboard state changes from the operator and contradicts spec §6); `redirect: 'error'` on fetch (GitHub's renamed-repository endpoints rely on same-origin redirects); a new origin-filtering layer in `fetch` (the client owns headers and URLs, so it must own the origin check).

**Consequence.** One copy of each cross-cutting rule, with fewer places to drift. JSON consumers still get exactly one document on stdout, while stderr may carry warnings; D022's stricter wording is superseded by this entry.

## D027 — Compact dashboard hierarchy for tracked owners

**Context.** When an account and its repositories are both tracked, the compact dashboard rendered them as unrelated rows: repositories showed `owner/name` and the account could sit at the bottom of the selection. The repeated owner and the distance between an account and its projects made the listing harder to scan.

**Decision.**

1. **Display-only grouping.** Nesting is computed from the rendered rows and never changes `[tracking]`, views, observation resolution, or JSON. JSON rows keep selection order and full `subject` values.
2. **Compact layout only.** `columns` deliberately keeps its Repositories and Accounts sections with full names. A repository cannot sit directly under its account without merging the sections and the differing metric columns, which is a larger change to the documented layout.
3. **Group at the earliest member.** A group is anchored at the minimum selection index of its account or any of its repositories, so a repository listed before its account pulls the account up rather than moving itself down. Repositories with untracked owners keep their place.
4. **Two-space indentation and no repeated owner.** Nested repositories drop the `owner/` prefix and are indented two spaces in the `NAME` cell. Owner matching is case-insensitive; display casing is preserved for the repository name.
5. **Only selected accounts group repositories.** A configured but unselected account has no effect, so `--subject` and saved views remain predictable.

**Rejected.** Merging columns into one table (a larger layout change than this refinement needs); rows nested on the JSON shape (couples presentation to the machine contract); moving all groups to the top (moves unrelated repositories for no user-visible gain); repeating the account on every nested row (the indentation is the hierarchy).

**Consequence.** The default dashboard reads top-down as account then projects. No storage or config migration is needed, and consumers of `--format json` see no change.

## D028 — Compact metric widths track actual values

**Context.** The compact layout reserved at least five characters for counts and for deltas including parentheses. That kept alignment stable but left visible dead space whenever every tracked value was small, because the five-character floor was larger than the widest number actually rendered. D023 §4 documented that floor.

**Decision.** The compact `METRICS` count and delta fields are exactly as wide as the widest formatted value and delta in the rendered list. There is no fixed minimum. The count field starts at one character so the `—` of a never-fetched subject still fits, and the delta field collapses to zero when every baseline is missing. The compacted-marker slot is reserved only when the list actually contains a compacted value; a raw-only list does not pay for a blank `~` slot. Labels stay variable-width, and the whole `METRICS` cell stays right-aligned, so the numeric fields remain aligned across rows.

**Rejected.** Keeping the five-character floor for counts (the reported problem); shrinking only counts and leaving deltas padded (deltas are the other number field and suffer the same dead space); per-metric widths (the numeric fields would stop aligning across metric lines); a fixed label width (changes the documented variable-label layout for no gain).

**Consequence.** Narrow dashboards lose the artificial padding, while wide values still widen their fields rather than truncating. This amends D023 §4's "at least five characters" wording; D023 is otherwise unchanged.

## D029 — Relative date refs for `--from` / `--to`

**Context.** Ranges had to be written with absolute days or run ids, so "the last year" needed a hand-computed date, and on a fresh dataset `--from <one year ago>` failed because no point existed on or before the bound.

**Decision.**

1. **One offset syntax, shared everywhere.** `--from` and `--to` (diff, dashboard, `track view save`, export) accept `-<n><unit>` with units `d`, `w`, `m`, and `y`. Offsets resolve once per invocation against the current UTC day and then reuse the existing `YYYY-MM-DD` rules, so every consumer shares one parser and one set of semantics. Amounts are positive integers and only past offsets are accepted.
2. **Calendar arithmetic.** Days and weeks shift whole days; months and years are calendar-based and clamp the day, so `2026-03-31 -1m` is `2026-02-28` and `2024-02-29 -1y` is `2023-02-28`.
3. **Nearest stored point.** A date-like `--from` older than the data snaps forward to the oldest point (diff) or the oldest observation of that subject (dashboard). A date-like `--to` older than the data exits `2` with `usage` in diff, naming the bound and the oldest day; in dashboard the row has no `to` observation and renders `—`. Run ids stay exact and never snap.
4. **Parser seam.** The CLI accepts a leading `-` as an option value only for `--from`/`--to`, using a loose shape; strict validation stays in the ref parser so `-1x` and `-0d` produce an invalid-reference error rather than "requires a value".
5. **Resolved range is visible.** The diff text report always prints `Range: <from-day> to <to-day> (UTC days)`, and JSON endpoints carry `day`. Saved views store the literal offset, so a `-1y` view is a rolling window.

**Rejected.** Offsets only, with no absolute dates (breaks existing scripts); resolving offsets to exact timestamps (points are day-granular; it would add false precision); clamping `--to` upward to the newest point (a window entirely before the data would silently dump everything); storing resolved days in `[views]` (a saved `-1y` is meant to roll); future offsets (`+1d`), because there is no future data; hour units, because points are days.

**Consequence.** `--from -1y --to latest` works on a fresh dataset, and every report shows the days actually compared. This extends D021 §1 and D023's range rules without changing keyword or run-id behavior.

## Plan history

Active plans are owned by the coding harness and are never committed to this repository. This section is the durable record of what was planned, what shipped, and what remains. Statuses: `done`, `partial`, `not started`, `superseded`, `abandoned`.

| Plan | Dates | Status | Delivered | Not done / carried forward |
|---|---|---|---|---|
| v1 — core CLI (M1–M6) | 2026-10-19 → 2026-10-20 | done | `watch`, `fetch` with resume, `runs`, `diff`, `compact`, `export`; atomic immutable runs; JSON purity; offline test suite | M7 interactive first-run setup |
| Dashboard (M8) | 2026-10-20 | done | `dashboard` and `track`; per-subject observations; `[tracking]` and `[views]`; compact/columns layouts; clack picker | None |
| Dashboard add (M8.1) | 2026-10-20 | done | `dashboard add`; composite watch+track; public-repository browsing and multi-select; removed `--setup` | None |

The retired `docs/plans/` files remain in git history at commit `3deedbb` (`feat: implement M8 dashboard and tracking`). This section replaces the folder as the place to answer "what has been done, and what is left?"

## Open backlog

Not started or deliberately deferred. Each item links to its decision where one exists.

- **M7 — interactive first-run setup.** Post-v1; decision and behavior in [D017](#d017--interactive-first-run-setup).
- **Authentication and private repositories.** `--token` exists, but stored credentials, keyring integration, per-subject authentication, and private-repository support are deferred (D004).
- **Gzip-compressed raw runs.** Deferred; the 30-day raw window bounds current disk usage (D014).
- **Starred-list tracking.** Rejected for v1; revisit only if the original use case resurfaces (D005).
- **Scheduling helpers.** No cron, daemon, or `--if-due` in v1.
- **Multi-machine sync.** Out of scope; local-first files only (D001).
- **Same-second run suffix.** Same-second runs currently error; add a suffix only if it ever matters (D002).

The former open question about compaction width is resolved by [D023](#d023--dashboard-narrow-metrics-per-subject-observations-full-snapshot-views): the history schema stays narrow.

## Related

- [Goal](00_GOAL.md)
- [Architecture](01_ARCHITECTURE.md)
- [Spec](02_SPEC.md)
- [Dashboard](04_DASHBOARD.md)
