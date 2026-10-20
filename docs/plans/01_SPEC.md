---
title: "01 — Spec"
type: plan
status: done
updated: 2026-10-20
---

# 01 — Spec

Binding contract for the CLI. If implementation and this document disagree, either fix the code or amend this document and record the change in [03_DECISIONS.md](03_DECISIONS.md).

## 1. Invocation

```
gh-track <command> [subcommand] [arguments] [options]
```

Global options may appear before or after the command. Command options win over global defaults when both describe the same setting.

```
--config <path>       Config file (default: $XDG_CONFIG_HOME/gh-track/config.toml)
--data-dir <path>     Data directory (default: $XDG_DATA_HOME/gh-track)
--format <fmt>        table (default) | json; export also accepts jsonl | csv
--no-color            Disable ANSI color
--yes                 Assume "yes" for confirmations; never prompt
--verbose             Extra diagnostics on stderr
-h, --help            Help for the current level
-V, --version         Print "gh-track <version>" and exit 0
```

Rules:

- Unknown options and unknown commands exit `2`.
- `--help` always wins over other work and exits `0`.
- `--format` values are validated per command. Unsupported values exit `2`.
- `NO_COLOR` is honored. Color is used only when stdout is a TTY, `--no-color` is absent, and the format is `table`.
- The process exits without waiting when a command completes; no background work.

## 2. Commands

### 2.1 `fetch`

Fetch and snapshot watched subjects.

```
gh-track fetch [subject...] [options]

  --dry-run                 Print the request plan, spend no quota, write nothing
  --max-requests <n>        Hard cap for this run; may only lower the quota-derived cap
  --resume [<run-id>]       Continue a partial run (default: most recent partial)
  --no-compact              Skip automatic compaction and pruning
  --keep-raw-days <n>       Override raw_retention_days for this run
  --token <token>           Use this token for the Authorization header
```

Subject arguments accept `user:<login>`, `repo:<owner>/<name>`, or a bare value. A bare value containing `/` is a repository; otherwise it is a user. Duplicate subjects are deduplicated with a warning.

Behavior:

- With no subject arguments, fetch every configured subject.
- With subject arguments, fetch only those. They are **not** added to the config.
- `--resume` ignores subject arguments and uses the manifest's pending list.
- `--resume` cannot be combined with `--dry-run`.
- If the plan cost exceeds the effective cap, fetch up to the cap, mark the run `partial`, and exit `3`.
- After a `complete` run, run compaction and pruning unless `--no-compact`.
- A run that fetches zero requests (empty watchlist) exits `2` with `empty_watchlist`.

### 2.2 `watch`

Manage the configured watchlist. Writes are atomic.

```
gh-track watch add user <login> [--resources followers,repos]
gh-track watch add repo <owner/name>
gh-track watch ls
gh-track watch rm <subject>
```

- `--resources` defaults to `followers,repos`; values must be a non-empty subset of that set. Valid only for `user`.
- Adding an existing subject updates its resources and reports `updated: true` rather than duplicating it.
- `watch rm` accepts any subject form. Removing an unknown subject exits `2` with `unknown_subject`.
- With no arguments, `watch add` prompts (see §7); `watch rm` with no subject prompts for a configured subject.
- `watch ls` is the "what am I tracking" view. It shows each subject's type, resources, and last-run summary (id, status, finished time, repository count, follower count). A subject with no runs shows `never`.

### 2.3 `runs`

Inspect stored runs.

```
gh-track runs ls [--limit <n>]
gh-track runs show <run-id>
gh-track runs paths <run-id>
```

- `ls` defaults to the 20 most recent runs, newest first. `--limit` must be a positive integer.
- `show` prints the manifest summary; with `--format json`, the complete manifest object.
- `paths` prints the absolute run directory, one line. With `--format json`, `{"path":"..."}`.
- Unknown run id exits `1` with `run_not_found`.

### 2.4 `diff`

Compare two points in time. Never writes files.

```
gh-track diff [options]

  --from <ref>     Start point (default: previous complete run before --to)
  --to <ref>       End point (default: latest complete run)
  --subject <s>    Repeatable; restrict to one or more subjects
```

References:

| Form | Meaning |
|---|---|
| `latest` | Most recent complete run |
| `previous` | Most recent complete run before the resolved `--to` |
| `<run-id>` | That run, which must be `complete` |
| `YYYY-MM-DD` | Most recent complete run on or before that UTC day |

- At least two complete runs are required; otherwise exit `1` with `not_enough_runs`.
- `--from` must resolve to a time before `--to`; otherwise exit `2` with `invalid_range`.
- Raw data is used when both sides are within retention. If either side must come from compacted history, the output reports `"source": "compacted"` (or `"mixed"`) and limits fields to `stars`, `forks`, and `followers`, with no follower identities.
- A run-id reference must name a complete run that is still on disk. Date and keyword references may resolve to a compacted day after its raw run is pruned.
- A compacted endpoint reports the UTC date as `id` and `finishedAt: null`, because the exact finish time is not retained.
- Repositories are matched by numeric `id`, falling back to `full_name`.
- A repository present only in `--to` is `added`; only in `--from` is `removed`; same `id` with a different `full_name` is `renamed`.
- Follower sets are compared case-insensitively by login.
- `--subject repo:<owner/name>` restricts to that repository (and its previous name when renamed). `--subject user:<login>` restricts to that account's follower diff plus repositories owned by that login.

### 2.5 `compact`

```
gh-track compact [--keep-days <n>] [--dry-run]
```

- Eligible days are older than the retention window (UTC) and have at least one complete run.
- Uses the last complete run of each day.
- Upserts history lines by date.
- Prunes raw runs only for days compacted in this invocation or previously marked compacted.
- Compacted days are recorded in `state/compacted.json`; pruning reads that marker, so it never deletes a day that has only partial runs.
- Idempotent. `--dry-run` reports what would change without writing or deleting.
- No confirmation is required: it only deletes raw data that has already been compacted.

### 2.6 `export`

```
gh-track export [options]

  --format <fmt>    json | jsonl | csv   (default: jsonl)
  --subject <s>     Repeatable filter
  --from <date>     Inclusive UTC start date (YYYY-MM-DD)
  --to <date>       Inclusive UTC end date (YYYY-MM-DD)
```

- Exports compacted history only. Raw runs are accessible via `runs paths`.
- `json` emits one object: `{"exportedAt":"...","rows":[...]}`.
- `jsonl` emits one history row per line.
- `csv` emits a header row: `date,kind,subject,stars,forks,followers`, where `kind` is `repo` or `user`, and unused cells are empty.
- Rows are sorted by date, then `kind`, then subject. JSON and JSONL rows use the same fields as the CSV columns, omitting metrics that do not apply: repository rows have `stars` and `forks`, account rows have `followers`.
- Malformed `--from`/`--to` values exit `2` with `usage`.
- Exporting with no matching history exits `1` with `no_history`.

### 2.7 `help`

```
gh-track help [command...]
```

Equivalent to `--help` at that level. `gh-track help watch add` and `gh-track watch add --help` render the same page.

### 2.8 `dashboard`

Render the selected subjects and metrics as a read-only value view. Never writes, except when the setup picker runs.

```
gh-track dashboard [options]

  --view <name>            Render a saved view
  --from <ref>             Baseline bound (default: previous observation)
  --to <ref>               Current bound (default: latest)
  --subject <s>            Repeatable; override the item set with configured subjects
  --layout <fmt>           compact (default) or columns
  --setup                  Run the setup picker before rendering
```

- Metrics are fixed: `stars` and `forks` for repositories, `followers` for accounts.
- References use the diff forms: `latest`, `previous`, a run id, or `YYYY-MM-DD`. `--to` cannot be `previous`.
- Each subject resolves its own observations. Raw runs win over compacted history for the same day.
- A subject with no observations is included with `—`.
- `--from previous` selects each row's observation immediately before its `to` observation.
- `--from latest` uses the same observation as `to`, so deltas are zero.
- A run-id reference must name a complete run on disk, matching `diff`.
- With no `--view`, no `--subject`, and no `[tracking]` entries, the dashboard uses every configured subject with default metrics.
- On a TTY with the prompt gate open, that first-run case offers the setup picker and saves `[tracking]`. `--setup` forces it. With the gate closed, the defaults render without prompting.
- `--subject` replaces the item set with the named configured subjects. Their metrics come from the active view, then `[tracking]`, then defaults. An unconfigured subject exits `2` with `unknown_subject`.
- An empty item set exits `2` with `no_selection`. An empty watchlist exits `2` with `empty_watchlist`.
- `--view` names a missing view exits `2` with `unknown_view`.
- `dashboard` takes no lock.

### 2.9 `track`

Manage the dashboard selection.

```
gh-track track edit
gh-track track set --item <subject>=<metrics>...
gh-track track rm <subject>
gh-track track ls
gh-track track view save <name> [--item ...] [--layout compact|columns] [--from <ref>] [--to <ref>]
gh-track track view rm <name>
```

- `track edit` prompts for subjects and per-subject metrics, then writes `[tracking]` atomically. It requires the prompt gate.
- `track set` is the non-interactive equivalent. `--item` is repeatable; `subject=stars,forks` sets or replaces that subject's selection. Unknown or unconfigured subjects exit `2` with `unknown_subject`.
- `track rm` removes a subject from `[tracking]`. A subject that is not tracked exits `2` with `usage`.
- `track ls` lists the default selection and every saved view.
- `track view save` writes a full snapshot: items, layout, and range. Without `--item` it runs the picker; supplying `--layout`, `--from`, or `--to` skips the matching prompt. It replaces an existing view of the same name.
- `track view rm` removes a view; an unknown name exits `2` with `usage`.
- Config writes are atomic. `watch rm` also removes the subject from `[tracking]` and view `items`; a view left with no items is removed with a warning.

## 3. Subject syntax

| Canonical | Accepted in `fetch`, `diff --subject`, `watch rm` |
|---|---|
| `user:octocat` | `user:octocat`, `octocat` |
| `repo:torvalds/linux` | `repo:torvalds/linux`, `torvalds/linux` |

- `watch add` requires the explicit subtype (`user` or `repo`).
- Logins are case-insensitive; store the casing returned by the API.
- Repository names come from `full_name`; normalize to that casing for storage and display.
- Empty strings, whitespace, and values with more than one `/` exit `2` with `invalid_subject`.

## 4. Config (TOML)

Path: `$XDG_CONFIG_HOME/gh-track/config.toml`, default `~/.config/gh-track/config.toml`.

```toml
schema_version = 1

[defaults]
raw_retention_days = 30      # integer >= 1
token_env = "GH_TOKEN"       # env var read when --token is absent; "" disables
request_timeout_ms = 30000   # integer >= 1000
max_retries = 3              # integer 0..10

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers", "repos"]

[[subjects]]
type = "repo"
repo = "torvalds/linux"

[tracking."repo:octocat/hello-world"]
metrics = ["stars", "forks"]

[tracking."user:octocat"]
metrics = ["followers"]

[views."my-repos"]
layout = "columns"
from = "2026-09-01"
to = "latest"

[[views."my-repos".items]]
subject = "repo:octocat/hello-world"
metrics = ["stars"]

[[views."my-repos".items]]
subject = "user:octocat"
metrics = ["followers"]
```

Validation:

| Rule | Failure |
|---|---|
| `schema_version` must be `1` | `config_invalid`, exit `2` |
| Unknown keys anywhere | `config_invalid`, exit `2` |
| `raw_retention_days >= 1` | `config_invalid` |
| `request_timeout_ms >= 1000` | `config_invalid` |
| `max_retries` in `0..10` | `config_invalid` |
| `type` is `user` or `repo` | `config_invalid` |
| `user` requires `account`; `repo` requires `repo` with exactly one `/` | `config_invalid` |
| `resources` non-empty subset of `followers,repos`; only for `user` | `config_invalid` |
| Duplicate canonical subject | Deduplicate, warn on stderr, keep the union of resources |
| `[tracking]` or `[views]` references a subject not in `[[subjects]]` | `config_invalid` |
| Tracking metrics empty or invalid for the subject kind | `config_invalid` |
| View name is not `[a-z0-9][a-z0-9_-]*` or has no items | `config_invalid` |
| View `to` is `previous`, or a range value is not a valid reference | `config_invalid` |
| Duplicate tracking/view item for one subject | Deduplicate metrics with a warning |

Tracking keys are canonical subjects (`user:<login>` or `repo:<owner>/<name>`). A bare key is accepted and canonicalized. `[views.<name>]` stores a full snapshot: `items`, `layout` (`compact` or `columns`), `from`, and `to`; missing range fields default to `previous` and `latest`.

A missing config file is allowed for `fetch <subject>`, `runs`, `help`, and `--version`. Commands that need the watchlist (`fetch` with no arguments, `watch ls`) exit `2` with `config_missing`.

`watch add` creates the file and parent directories if needed. Writes go to a temp file in the same directory and are renamed. Comments may not survive a rewrite; that is acceptable.

## 5. Data schemas

All paths inside a run are relative to the run directory. All timestamps are ISO-8601 UTC with milliseconds.

### 5.1 Manifest — `manifest.json`

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

- `status`: `complete` | `partial` | `failed`.
- `pending` entries use `{ "subject": "...", "resource": "...", "url": "...", "page": n }`.
- `errors` entries use `{ "subject": "...", "resource": "...", "url": "...", "status": n, "code": "...", "message": "..." }`.
- `304` entries still have a `path`: the previous payload is copied into the new run so it stays self-contained. They also carry `sourceRun` and `sourcePath` pointing at the origin, plus `status: 304`.

### 5.2 ETag cache — `state/etags.json`

```json
{
  "https://api.github.com/users/octocat/followers?per_page=100&page=1": {
    "etag": "W/\"abc123\"",
    "lastModified": "Mon, 19 Oct 2026 21:00:00 GMT",
    "checkedAt": "2026-10-19T21:30:05.900Z",
    "lastStatus": 200,
    "sourceRun": "2026-10-18T09-00-00Z",
    "sourcePath": "accounts/octocat/followers/page-0001.json"
  }
}
```

The cache is advisory and may be deleted at any time.

### 5.3 Rate-limit cache — `state/limits.json`

```json
{
  "limit": 60,
  "remaining": 41,
  "resetAt": "2026-10-19T22:00:00.000Z",
  "observedAt": "2026-10-19T21:30:06.100Z"
}
```

Headers from the current response always override the cache.

### 5.4 History — `history/repos/<owner__repo>.ndjson`

```json
{"date":"2026-10-19","repository":"octocat/hello-world","stars":123,"forks":4}
```

### 5.5 History — `history/users/<login>.ndjson`

```json
{"date":"2026-10-19","account":"octocat","followers":340}
```

### 5.6 `watch ls --format json`

```json
{
  "configPath": "/home/az/.config/gh-track/config.toml",
  "dataDir": "/home/az/.local/share/gh-track",
  "defaults": {
    "rawRetentionDays": 30,
    "tokenEnv": "GH_TOKEN",
    "requestTimeoutMs": 30000,
    "maxRetries": 3
  },
  "subjects": [
    {
      "subject": "user:octocat",
      "type": "user",
      "account": "octocat",
      "resources": ["followers", "repos"],
      "lastRun": {
        "id": "2026-10-19T21-30-05Z",
        "status": "complete",
        "finishedAt": "2026-10-19T21:30:09.812Z",
        "repos": 12,
        "followers": 340
      }
    },
    {
      "subject": "repo:torvalds/linux",
      "type": "repo",
      "repo": "torvalds/linux",
      "resources": ["repo"],
      "lastRun": null
    }
  ]
}
```

`lastRun` is `null` when the subject has never been fetched successfully or partially.

### 5.7 `runs ls --format json`

```json
{
  "runs": [
    {
      "id": "2026-10-19T21-30-05Z",
      "status": "complete",
      "startedAt": "2026-10-19T21:30:05.123Z",
      "finishedAt": "2026-10-19T21:30:09.812Z",
      "subjects": 2,
      "repos": 12,
      "followers": 340,
      "requests": 7,
      "notModified": 2
    }
  ]
}
```

### 5.8 `fetch --format json`

Complete:

```json
{
  "run": {
    "id": "2026-10-19T21-30-05Z",
    "status": "complete",
    "startedAt": "...",
    "finishedAt": "...",
    "stats": { "repos": 12, "followers": 340, "requests": 7, "notModified": 2 }
  },
  "compaction": { "compactedDays": 1, "prunedRuns": 1 },
  "pending": [],
  "resumeAfter": null
}
```

Partial:

```json
{
  "run": {
    "id": "2026-10-19T21-30-05Z",
    "status": "partial",
    "startedAt": "...",
    "finishedAt": "...",
    "stats": { "repos": 4, "followers": 100, "requests": 5, "notModified": 0 }
  },
  "compaction": null,
  "pending": [
    { "subject": "user:octocat", "resource": "followers", "url": "...", "page": 2 }
  ],
  "resumeAfter": "2026-10-19T22:00:00.000Z"
}
```

Dry run:

```json
{
  "dryRun": true,
  "effectiveMaxRequests": 58,
  "estimatedRequests": 7,
  "plan": [
    { "subject": "user:octocat", "resource": "repos", "url": "...", "page": 1, "conditional": true }
  ]
}
```

### 5.9 `diff --format json`

```json
{
  "from": { "id": "2026-10-18T09-00-00Z", "finishedAt": "..." },
  "to": { "id": "2026-10-19T21-30-05Z", "finishedAt": "..." },
  "source": "raw",
  "repos": [
    {
      "id": 123456,
      "repository": "octocat/hello-world",
      "change": "changed",
      "fields": {
        "stargazers_count": { "from": 120, "to": 132, "delta": 12 },
        "forks_count": { "from": 3, "to": 4, "delta": 1 },
        "archived": { "from": false, "to": true }
      }
    },
    {
      "id": 987654,
      "repository": "octocat/new-name",
      "previousRepository": "octocat/old-name",
      "change": "renamed",
      "fields": {}
    }
  ],
  "users": [
    {
      "account": "octocat",
      "followers": {
        "from": 340,
        "to": 341,
        "delta": 1,
        "added": [{ "login": "newperson", "id": 42 }],
        "removed": []
      }
    }
  ]
}
```

- `source`: `raw` | `compacted` | `mixed`.
- `change`: `changed` | `added` | `removed` | `renamed`.
- Under `compacted`/`mixed`, `fields` contains only `stargazers_count` and `forks_count`, and each `followers` object carries `"added": null`, `"removed": null`, `"identitiesAvailable": false`.
- Field names mirror the GitHub payload (`stargazers_count`), not human aliases. Tables may render friendlier labels.
- Scalar fields present on only one side are included with the missing side as `null`; an explicit `null` is a value, not a missing key. Added, removed, and rename-only entries carry `"fields": {}`.
- A compacted `from`/`to` uses the UTC date as `id` and `null` as `finishedAt`.

### 5.10 `compact --format json`

```json
{
  "dryRun": false,
  "compacted": [{ "date": "2026-09-01", "repos": 12, "users": 1 }],
  "pruned": [{ "id": "2026-09-01T10-00-00Z", "path": "..." }]
}
```

### 5.11 Errors

With `--format json`, errors are emitted to **stderr** as one object, and stdout is empty:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Rate limit exhausted; resume after 2026-10-19T22:00:00.000Z",
    "details": { "resumeAfter": "2026-10-19T22:00:00.000Z" }
  }
}
```

Codes: `usage`, `config_invalid`, `config_missing`, `empty_watchlist`, `invalid_subject`, `unknown_subject`, `unknown_view`, `no_selection`, `run_not_found`, `not_enough_runs`, `invalid_range`, `no_history`, `rate_limited`, `network`, `http_error`, `io_error`, `locked`, `interrupted`, `internal`.

### 5.12 Compacted-day marker — `state/compacted.json`

```json
{
  "days": ["2026-09-01", "2026-09-02"]
}
```

- Sorted, unique UTC days whose raw runs have been compacted into history.
- Written after the history upsert for a day and before pruning.
- Advisory like the other state files: a missing or corrupt file means "no days compacted", so the next compaction re-runs and re-prunes rather than deleting unmarked data.

### 5.13 `export --format json` rows

```json
{
  "exportedAt": "2026-10-20T12:00:00.000Z",
  "rows": [
    { "date": "2026-09-01", "kind": "repo", "subject": "octocat/hello-world", "stars": 123, "forks": 4 },
    { "date": "2026-09-01", "kind": "user", "subject": "octocat", "followers": 340 }
  ]
}
```

- Repository rows carry `stars` and `forks`; account rows carry `followers`. Unused metric fields are absent, not `null`.
- `jsonl` emits exactly one row object per line in the same order.

### 5.14 `dashboard --format json`

```json
{
  "view": "my-repos",
  "layout": "compact",
  "range": { "from": "2026-09-01", "to": "latest" },
  "rows": [
    {
      "kind": "repo",
      "subject": "repo:octocat/hello-world",
      "source": "raw",
      "from": { "id": "2026-10-18T09-00-00Z", "finishedAt": "2026-10-18T09:00:01Z" },
      "to": { "id": "2026-10-19T09-00-00Z", "finishedAt": "2026-10-19T09:00:03Z" },
      "metrics": {
        "stars": { "value": 132, "from": 120, "delta": 12 },
        "forks": { "value": 4, "from": 3, "delta": 1 }
      }
    }
  ]
}
```

- `view` is absent for the default selection.
- `source` is per row: `raw`, `compacted`, `mixed`, or `null` when the row has no `to` observation (never fetched or outside the selected range).
- A compacted observation uses the UTC date as `id` and `null` as `finishedAt`.
- A never-fetched row has `source: null`, `from: null`, `to: null`, and `{value: null, from: null, delta: null}` for each selected metric.
- Rows follow the selection order; default selections follow `[[subjects]]` order.
- `--format json` never prompts.

### 5.15 `track ls --format json`

```json
{
  "tracking": [
    { "subject": "repo:octocat/hello-world", "metrics": ["stars", "forks"] },
    { "subject": "user:octocat", "metrics": ["followers"] }
  ],
  "views": [
    {
      "name": "my-repos",
      "layout": "columns",
      "from": "2026-09-01",
      "to": "latest",
      "items": [
        { "subject": "repo:octocat/hello-world", "metrics": ["stars"] }
      ]
    }
  ]
}
```

## 6. Streams and exit codes

| Stream | Content |
|---|---|
| stdout | The command's result only: tables, JSON, paths, help |
| stderr | Progress, warnings, verbose diagnostics, errors |

- `--format json` output is one document plus a trailing newline. No ANSI, spinners, or prompts.
- Table output may use color only under the conditions in §1.
- Exit codes: `0` success, `1` runtime failure, `2` usage/config error, `3` partial fetch, `130` interrupted.
- A diff with no changes exits `0` and reports empty change lists.
- `fetch` that finds nothing to do exits `0` with `estimatedRequests: 0` only when the watchlist is non-empty but all resources are cached; an empty watchlist is `2`.

## 7. Interactive prompts

`@clack/prompts` is used for:

| Command | Prompt |
|---|---|
| `watch add` with no arguments | Select type (`user` / `repo`), then text input, then confirm |
| `watch rm` with no subject | Select from configured subjects, then confirm |
| `watch rm <subject>` | Confirm removal |
| `dashboard` with no selection | Setup picker: subjects, then per-repository metrics; saves `[tracking]` |
| `dashboard --setup` | The same setup picker, even when a selection exists |
| `track edit` | The same setup picker; saves `[tracking]` |
| `track view save <name>` without `--item` | Setup picker plus layout and compare-from; saves the view |
| `fetch` | Progress spinner only; never a question |
| `compact` / `fetch --no-compact` | No confirmation |

Rules:

- Prompts run only when `stdin.isTTY && stdout.isTTY`, the format is `table`, and `--yes` is absent.
- `--format json` is always non-interactive, even on a TTY.
- In non-interactive mode, missing arguments exit `2` with a message that includes the exact non-interactive invocation. `watch rm` requires `--yes` in non-interactive mode.
- `Ctrl-C` exits `130`; no partial confirmation is applied.
- Spinners are written to stderr and are suppressed in JSON mode or when stderr is not a TTY.

## 8. Help

A single registry drives every page. Each command node carries: `name`, `summary`, `usage`, `options[]`, `examples[]` (possibly empty), and `children`.

Rules:

- `gh-track --help` lists commands with one-line summaries and global options.
- `gh-track <command> --help` shows usage, options, and subcommands if any.
- `gh-track <command> <subcommand> --help` shows the leaf page.
- An `Examples` section renders only when at least one example exists. No placeholder text.
- Help goes to stdout and exits `0`. Unknown commands print usage to stderr and exit `2`.
- Help is never rendered as JSON.

Template:

```
gh-track fetch — fetch and snapshot watched subjects

Usage:
  gh-track fetch [subject...] [options]

Arguments:
  subject                 user:<login>, repo:<owner>/<name>, or a bare value

Options:
  --dry-run               Print the request plan without spending quota
  ...

Examples:
  gh-track fetch
  gh-track fetch user:octocat
```

## 9. HTTP behavior

- `User-Agent: gh-track/<version>` and `Accept: application/vnd.github+json` on every request.
- `X-GitHub-Api-Version: 2022-11-28`.
- Timeout per request from config; timeout is a retryable network error.
- Pagination follows `Link: rel="next"` when present, otherwise stops on a short page. A hard cap of 1000 pages prevents runaway loops.
- Conditional requests send `If-None-Match` from `state/etags.json`.
- Retries: `5xx` and network errors, up to `max_retries`, exponential backoff with jitter starting at 500 ms. `403`/`429` honor `Retry-After`; primary-limit exhaustion is not retried in the same run.
- `404` is recorded as a subject error and the run continues.
- Response bodies must parse as JSON; otherwise the request fails and the run becomes `partial`.
- Tokens are never logged. `--verbose` redacts the `Authorization` header.

## 10. Retention and compaction rules

- `raw_retention_days` default `30`, minimum `1`.
- A UTC day is eligible when `day < todayUTC - raw_retention_days`.
- A day with only partial or failed runs is not compacted and not pruned.
- Compaction uses the last `complete` run of the day, not merely the last run.
- Pruning removes the entire run directory for a compacted day.
- Re-running compaction for a day replaces its history line (upsert by date).
- History files are sorted by date after every write.
- Deletion is recursive but confined to `runs/<id>/`; the code refuses to prune a path that does not match the run-id pattern.
- Compacted days are tracked in `state/compacted.json`; only days in that marker are pruned.

## 11. Concurrency and locking

- One `fetch` at a time per data directory.
- Lock file: `locks/fetch.lock` containing `{ "pid": n, "startedAt": "..." }`.
- If the pid is alive, exit `1` with `locked`. If the pid is dead, reclaim the lock.
- `compact` takes the same exclusive lock because it writes history and deletes runs. `compact --dry-run` takes no lock and writes nothing.
- `runs`, `diff`, `export`, and `dashboard` read atomically written files without a lock.
- `track` writes the config atomically. It does not take the fetch lock because it never touches run data.
- Writers use temp file + rename. Readers must tolerate a missing `state/*.json` and rebuild it.

## 12. Compatibility

- Runtime: Node >= 20 (global `fetch`, `node:util`, `node:test`).
- Bun >= 1.1 for development and packaging.
- No `bun:*` imports in `src/`. Tests also use Node APIs.
- ESM only. `package.json` gains `"type": "module"` during implementation.
- Windows is best effort; path handling must use `node:path` and never hard-code `/`.

## Related

- [Architecture](../01_ARCHITECTURE.md)
- [Implementation](02_IMPLEMENTATION.md)
- [Decisions](03_DECISIONS.md)
