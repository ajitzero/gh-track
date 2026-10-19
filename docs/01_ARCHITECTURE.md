---
title: "01 — Architecture"
type: core
status: active
updated: 2026-10-19
---

# 01 — Architecture

This document describes how the pieces fit. Exact CLI syntax and JSON shapes live in [01_SPEC.md](plans/01_SPEC.md); milestones live in [02_IMPLEMENTATION.md](plans/02_IMPLEMENTATION.md).

## Context

```
                        ┌──────────────────────────┐
       user ───────────▶│ cli.ts  /  help registry │
                        └────────────┬─────────────┘
                                     │
            ┌────────────────────────┼─────────────────────────┐
            ▼                        ▼                         ▼
      config.toml              fetch planner             inspect / diff
      (TOML, XDG)                    │                         │
                                     ▼                         ▼
                            github/client ── ETag cache   runs/ + history/
                            rate limiter                        │
                                     │                          ▼
                                     ▼                    output (table|json)
                              GitHub REST API
                                     │
                                     ▼
                        runs/.tmp-<run-id>/ ──rename──▶ runs/<run-id>/
                                                              │
                                              auto-compact + prune (on success)
                                                              ▼
                                                         history/
```

Nothing runs in the background. Every box is reached from a single CLI invocation.

## Domain model

| Concept | Definition | Canonical key |
|---|---|---|
| **Subject** | Something watched over time | `user:<login>` or `repo:<owner>/<name>` |
| **Resource** | A REST endpoint fetched for a subject | `followers`, `repos`, `repo` |
| **Run** | One invocation producing one snapshot | ISO-8601 UTC timestamp |
| **Observation** | A subject's state at a point in time | Derived from a run |

### Subjects and resources

| Subject | Resources fetched | Why |
|---|---|---|
| `user:<login>` | `followers`, `repos` | Follower churn and star/fork counts across every repository the account owns (public repos only without a token) |
| `repo:<owner>/<name>` | `repo` | Metadata for a single repository not owned by a watched account |

There is deliberately no `user.profile` resource: the follower count is the length of the stored follower list, so an extra `/users/{login}` request buys nothing. There is deliberately no starred-list subject — it was considered and rejected (see [03_DECISIONS.md](plans/03_DECISIONS.md)).

### Resource endpoints

| Resource | Request | Pagination | Raw payload |
|---|---|---|---|
| `followers` | `GET /users/{login}/followers?per_page=100&page=N` | `Link: rel="next"`, fallback short page | Array of user objects |
| `repos` | `GET /users/{login}/repos?per_page=100&page=N&sort=updated` | same | Array of repo objects |
| `repo` | `GET /repos/{owner}/{name}` | none | One repo object |

An account with 80 repositories and 450 followers costs `1 + 5 = 6` requests. Stars for every owned repository arrive in the `repos` list, so individual `/repos/...` calls are never made for owned repositories.

Each element of a list response is expanded into its own file so the on-disk tree matches the mental model "account → repository → record". The original page payloads are also retained for replay and debugging.

## Components

| Module | Responsibility | Must not |
|---|---|---|
| `cli.ts` | Parse global flags, dispatch, map errors to exit codes | Contain fetching logic |
| `help.ts` | Command registry, per-level help rendering, examples | Hard-code command behavior |
| `config.ts` | Load, validate, and write TOML | Touch the network |
| `prompts/` | Clack wrappers and TTY gating | Run when `--format json` |
| `github/client.ts` | HTTP, auth header, timeouts, retries, ETag, rate-limit accounting | Know about the filesystem layout |
| `github/resources/*` | Build URLs, paginate, return typed payloads | Write files |
| `store/*` | XDG paths, temp-dir writes, manifests, history, pruning | Decide what to fetch |
| `diff/*` | Compare two runs or history ranges | Persist results |
| `output/*` | Table rendering, JSON serialization, colors | Mix human and machine output |

Dependency direction is one-way: `cli → commands → (github | store | diff | output)`. `github` never imports `store`; the fetcher returns payloads and `store` decides where they go. This keeps the HTTP layer testable with a fake `fetch` and makes run writing independently testable.

## Fetch data flow

1. Load config (or use explicit subject arguments).
2. Build a **plan**: an ordered list of requests, grouped by subject and resource.
3. Apply `--max-requests` and the last known quota; warn if the plan exceeds it.
4. If `--dry-run`, print the plan (table or JSON) and exit `0`.
5. Create `runs/.tmp-<id>/` and start the manifest.
6. For each request:
   - Send `If-None-Match` when an ETag exists for the URL.
   - On `200`, write the payload and record the new ETag.
   - On `304`, copy/link the previous stored payload into this run and mark it `notModified`.
   - On rate-limit exhaustion, stop, write `pending`, promote the run as `partial`, and set `resumeAfter`.
7. On success, write the final manifest and `rename()` the temp directory to `runs/<id>/`.
8. If complete, run compaction and pruning (unless `--no-compact`).
9. Emit the run summary.

`--resume <id>` loads a partial manifest, filters the plan to `pending`, and continues into the same run directory. It never refetches completed requests.

## Storage

### Directory resolution

| Purpose | Precedence |
|---|---|
| Data | `--data-dir` → `$XDG_DATA_HOME/gh-track` → `~/.local/share/gh-track` |
| Config | `--config` → `$XDG_CONFIG_HOME/gh-track/config.toml` → `~/.config/gh-track/config.toml` |

On Windows (best effort), fall back to `%LOCALAPPDATA%\gh-track` and `%APPDATA%\gh-track`. Linux and macOS are the primary targets. Directories are created with mode `0700`; a missing config is not an error for commands that do not need it.

### Tree

```
$XDG_DATA_HOME/gh-track/
├── state/
│   ├── etags.json
│   ├── limits.json
│   └── compacted.json
├── runs/
│   ├── .tmp-2026-10-19T21-30-05Z/     # in progress, never considered a run
│   └── 2026-10-19T21-30-05Z/
│       ├── manifest.json
│       ├── accounts/
│       │   └── octocat/
│       │       ├── followers/page-0001.json
│       │       └── repos/
│       │           └── octocat__hello-world.json
│       └── repos/
│           └── torvalds__linux.json
├── history/
│   ├── repos/octocat__hello-world.ndjson
│   └── users/octocat.ndjson
└── locks/
```

- **Run IDs** are ISO-8601 UTC with `:` replaced by `-`: `2026-10-19T21-30-05Z`. Lexicographic order equals chronological order.
- **Repository file names** come from `full_name` with `/` replaced by `__`. Characters outside `[A-Za-z0-9._-]` are replaced with `-`. Identity is always the numeric `id` inside the payload, never the path, so renames do not create false diffs.
- **Account directories** use the login as returned by the API. GitHub logins are case-insensitive; the first observed casing is preserved.
- **No file is ever partially written.** Every JSON file is written to a sibling temp file and renamed.

### Manifest

`manifest.json` is the index for a run and the source of truth for resume:

```json
{
  "schemaVersion": 1,
  "id": "2026-10-19T21-30-05Z",
  "startedAt": "2026-10-19T21:30:05.123Z",
  "finishedAt": "2026-10-19T21:30:09.812Z",
  "status": "complete",
  "subjects": [
    { "subject": "user:octocat", "resources": ["followers", "repos"] }
  ],
  "stats": { "repos": 12, "followers": 340, "requests": 7, "notModified": 2 },
  "requests": [
    {
      "subject": "user:octocat",
      "resource": "followers",
      "url": "https://api.github.com/users/octocat/followers?per_page=100&page=1",
      "page": 1,
      "status": 200,
      "etag": "W/\"abc123\"",
      "path": "accounts/octocat/followers/page-0001.json"
    }
  ],
  "pending": [],
  "errors": []
}
```

`status` is `complete`, `partial`, or `failed`. A `failed` run records the error and is never resumed automatically. A `partial` run is resumable.

### State caches

`etags.json` maps a fully qualified URL to `{ etag, lastModified, checkedAt, lastStatus }`. It is rebuilt incrementally and is safe to delete (the next run simply refetches).

`limits.json` records the last observed `{ limit, remaining, resetAt, observedAt }`. It is advisory: it can be stale, so headers on the current response always win.

### History

Two NDJSON families, one line per UTC day:

```json
{"date":"2026-10-19","repository":"octocat/hello-world","stars":123,"forks":4}
{"date":"2026-10-19","account":"octocat","followers":340}
```

Files are kept sorted by date. Compaction is an upsert keyed by date, so re-running it for a day replaces that line rather than duplicating it. The set of compacted UTC days is recorded in `state/compacted.json`; pruning deletes raw runs only for days listed there, so a day with only partial runs is never compacted or pruned.

## Run lifecycle and atomicity

- Work happens in `runs/.tmp-<id>/`.
- Promotion is a single `rename()` on the same filesystem.
- A lock file in `locks/` contains the pid and start time. A second concurrent `fetch` exits with `locked` instead of interleaving writes. Stale locks (dead pid) are reclaimed.
- `SIGINT` during a fetch promotes the run as `partial` and exits `130`; it does not leave a `.tmp` directory behind.
- A crash that leaves `.tmp-*` behind is cleaned up at the start of the next fetch, after checking the pid.

## Rate limiting

Unauthenticated access allows **60 requests/hour per IP**, shared with every other unauthenticated process on that machine. The design assumes the quota is scarce:

- Parse `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` on every response and persist them.
- Keep a headroom of 2 requests. `--max-requests` defaults to `remaining - headroom` and may lower, never raise, the effective cap.
- Stop before the quota is exhausted rather than waiting for a `403`.
- On `403`/`429` with `Retry-After`, back off and retry up to the configured maximum; on primary-limit exhaustion, stop and mark the run partial with `resumeAfter` set to the reset time.
- ETag revalidation: send `If-None-Match`. Per GitHub's documentation a `304` does not count against the primary rate limit, and it lets us reuse the prior payload.
- The `--dry-run` plan is the primary defense: it tells you the cost of a watchlist before you spend quota.
- A token, when supplied, raises the limit to 5,000/hour. Private-repository features remain out of scope.

Retries use bounded exponential backoff with jitter for `5xx` and network errors. `404` is not retried; it is recorded as a subject error and the run continues.

## Compaction and retention

- Triggered automatically after a **complete** fetch (including a completed resume), and by the explicit `compact` command.
- A day is eligible when it is older than `raw_retention_days` (default 30) in UTC and has at least one complete run.
- The day's values come from the **last complete run of that day**. Partial runs are never used.
- Metrics written: `stars`, `forks` per repository, `followers` per account. This is intentionally the minimal set.
- Raw run directories are pruned only after their day has been compacted successfully. Days with only partial runs keep their raw data indefinitely until a complete run exists or the user compacts manually.
- Compaction and pruning are idempotent and support `--dry-run`.
- **Irreversibility:** once a day is compacted and pruned, diffs for that day are limited to stars, forks, and followers. This is the accepted cost of a small history; see [03_DECISIONS.md](plans/03_DECISIONS.md).

## Diff model

`diff` compares two points in time, resolved from run IDs, UTC dates, or the keywords `latest` / `previous`. It reads raw runs when both sides are raw, and falls back to compacted history when either side is older than the retention window. The output declares which source was used.

- **Repositories** are matched by numeric `id`, falling back to `full_name` when an id is unavailable. A rename therefore produces one `renamed` entry, not an add plus a remove.
- **Fields** are compared across all scalar values present in either payload. Numeric fields get a `delta`; booleans and strings get before/after values. Nulls are treated as values, not as missing.
- **Followers** are compared as sets keyed by login (case-insensitive), with the numeric id carried through for identity. Additions and removals are reported by login.
- **Repository presence** is itself a change: a repository absent from the newer run is `removed` (deleted, made private, or transferred); one absent from the older run is `added`.
- Diffs are never persisted. They are cheap to recompute and would duplicate stored data.

## Configuration

Config is TOML at `~/.config/gh-track/config.toml`. It holds defaults and the watchlist. Validation is strict: unknown keys are errors, invalid logins or repository names are errors, and duplicate subjects are deduplicated with a warning. `watch add` and `watch rm` rewrite the file atomically and preserve comments where practical; if preserving comments becomes fragile, the writer may normalize the file, and that is an acceptable tradeoff.

## Output contract

Every command supports `--format table` (human) and most support `--format json` (one document on stdout). `export` adds `jsonl` and `csv`. The rules are in [01_SPEC.md](plans/01_SPEC.md); the architectural commitment is that JSON output is never interleaved with progress, color, or prompts, and that exit codes are stable:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime failure (network, IO, insufficient history) |
| `2` | Usage or configuration error |
| `3` | Fetch completed partially; state is resumable |
| `130` | Interrupted |

## Failure modes

| Condition | Behavior |
|---|---|
| `200` | Store payload, update ETag, count quota |
| `304` | Reuse the previous payload, record `notModified` |
| Primary rate limit hit | Stop, mark run `partial`, set `resumeAfter`, exit `3` |
| Secondary rate limit / `429` | Back off per `Retry-After`, retry up to `max_retries`, then partial |
| `404` | Record subject error, continue the run |
| `5xx` / network error | Bounded retries, then mark the request failed and the run `partial` |
| Malformed JSON | Fail the request, mark the run `partial`; never write invalid data as complete |
| Repository renamed | New file path, same `id`; diff reports `renamed` |
| Repository deleted or made private | Absent from the list; diff reports `removed` |
| Concurrent fetch | Refuse with `locked`, exit `1` |
| Interrupt (`SIGINT`) | Promote as `partial`, exit `130` |

## Stack and boundaries

- TypeScript, ESM, compiled by `tsc` to `dist/`, executed by Node >= 20.
- Bun is the package manager and dev runner. Source must not import `bun:*`; Node built-ins and global `fetch` only. This keeps `npx gh-track` and `bunx gh-track` equivalent.
- Runtime dependencies: `@clack/prompts` and `smol-toml`. Dev dependencies: `typescript` and `@types/node`.
- No database, no ORM, no HTTP client library, no test framework beyond `node:test`.
- Tests use injected fake `fetch` implementations and recorded fixtures. No test hits the live API.

## Security and privacy

- Public data only in v1. A supplied token is used solely in the `Authorization` header and is never written to disk or logs.
- The token is redacted from verbose output and error messages.
- Data directories are created with mode `0700`; config files with `0600` once they can contain a token (they cannot in v1, but the mode is future-proof).
- No shell execution, no dynamic `eval`, and all URLs are built with `encodeURIComponent`.
- Nothing under the data directory is ever committed to the repository.

## Related

- [Goal](00_GOAL.md)
- [Spec](plans/01_SPEC.md)
- [Implementation](plans/02_IMPLEMENTATION.md)
- [Decisions](plans/03_DECISIONS.md)
