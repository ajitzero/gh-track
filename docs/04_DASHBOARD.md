Post-v1. A per-entity value view with a clack setup picker and an interactive TTY list. Static and JSON rendering remain available for scripts and pipes.

## Goal

Answer "what are my watched subjects at right now, and how did they move?" without reading raw runs. The dashboard shows one row per selected entity, the entity's selected metrics, and a delta against that entity's previous observation.

The two inputs are the same as [diff](02_SPEC.md):

- complete raw runs (30 days by default), which carry every scalar field;
- compacted history (`history/`), which carries only stars, forks, and followers.

Because the dashboard exposes only those three metrics, every row is comparable across the entire retained timeline. There is no widened history schema and no backfill problem.

## Decisions

Recorded as [D023](03_DECISIONS.md) and [D032](03_DECISIONS.md).

| Question | Decision |
|---|---|
| Metrics | Narrow: `stars`, `forks` for repositories; `followers` for accounts |
| Selection | Per-subject metrics in `[tracking]`; named views are full snapshots |
| Data points | Per-subject observations, merged from raw runs and history |
| Layout | `compact` by default; `columns` optional |
| Color | Blue = repositories, purple = accounts; green/red deltas; dim zero and `~` |
| Range | `--from` / `--to` only, reusing diff reference forms |
| Never fetched | Row is included with `—` |
| Baseline | A `SINCE` column in both layouts |
| Totals | Never (D009) |
| Setup | clack picker when no selection exists; `dashboard add` for incremental setup |
| Interaction | Alternate-screen TTY list; static table for JSON, non-TTY, `--yes`, and `--no-interactive` |

## Commands

```
gh-track dashboard [--view <name>] [--from <ref>] [--to <ref>]
                   [--subject <s>]... [--layout compact|columns] [--no-interactive]
gh-track [same dashboard options]          # dashboard is the default command
gh-track dashboard add [user <login> | repo <owner/name> | repo <owner> | <subject>]
gh-track track edit
gh-track track set --item <subject>=<metrics>...
gh-track track rm <subject>
gh-track track ls
gh-track track view save <name> [--item ...] [--layout ...] [--from ...] [--to ...]
gh-track track view rm <name>
```

- The dashboard writes only when the first-run picker runs, interactive `r` refreshes via `fetch`, or interactive `a` adds a subject and fetches it.
- Interactive mode uses the alternate screen and restores the terminal on exit. `--no-interactive` forces the static table and skips first-run setup prompts. JSON and non-TTY invocations are always static.
- `dashboard add` composes watch and tracking: it appends missing subjects to `[[subjects]]` and sets their `[tracking]` entry. It is additive and never touches `[views]`.
- `dashboard add repo <owner>` and the interactive repository path list the owner's public repositories and allow a multi-select, with a per-repository metrics prompt. `--metrics` and `--resources` make the explicit forms non-interactive.
- `--view` selects a full snapshot. `--subject` overrides the item set with configured subjects; their metrics come from the view, then `[tracking]`, then defaults.
- `--from` / `--to` override the view's range. `--layout` overrides the view's layout.
- `track edit` writes `[tracking]`; `track set` is its non-interactive equivalent.
- `track view save` writes a named view. Without `--item` it runs the picker.
- `track ls` lists the default selection and every view.

## Interactive list

On a TTY with table output and without `--yes`, the dashboard opens an alternate-screen list. The selected item is marked with `›`; the view scrolls to keep it visible. Keyboard hints appear in this order, separated by middots: `r refresh · ↑↓/j k move · / search · c copy · a add · q quit`. Each shortcut key renders white and its label renders dim grey; `NO_COLOR` drops the styling.

- `↑`/`↓` and `j`/`k` move one item; movement clamps at the ends. `g`/`G` and Home/End jump to the first/last item.
- `/` starts a fresh live substring filter. Enter keeps the filter; Escape clears it. In navigation mode Escape clears an active filter or quits if there is none. `q` quits in navigation mode; Ctrl-C always quits with exit code 130 and aborts an in-flight fetch.
- Search is case-insensitive. Compact mode searches displayed names, also accepting a full `owner/name`; a matching child repository keeps its tracked account header visible, while a matching account shows its complete group. Columns mode filters each row independently. While entering a query, printable `j`/`k` characters are treated as search text; arrow keys still move the highlight.
- `c` copies `https://github.com/<login>` or `https://github.com/<owner>/<repo>` for the selected account or repository. It tries `pbcopy`, `clip`, `wl-copy`, `xclip`, or `xsel` as appropriate, then falls back to OSC 52; success/failure is shown in the status line.
- `a` opens an inline add prompt on the status line. Typing accepts a bare login, `owner/name`, a canonical `user:` / `repo:` subject, or a GitHub profile/repository URL; Enter adds it to the watchlist and default selection, fetches only that subject, and refreshes the table with the new row highlighted. Escape cancels. An invalid value keeps the prompt open with the error; failures during the scoped fetch still leave the added row visible with `—` values. Existing subjects keep their stored resources and metric selection.
- `r` runs the regular `fetch` command for the entire watchlist in-process. It honors the fetch lock, API behavior, and automatic compaction. The displayed rows are rebuilt afterward while preserving the current subject, range, search, and selection. Errors and partial-run status are shown without closing the dashboard; keyboard input is ignored while refresh is running. Ctrl-C aborts an in-flight fetch and restores the terminal.
- Quitting restores raw mode, cursor, line wrapping, and the prior screen; no static table is printed afterward. Use `--no-interactive` when the table should remain in scrollback.

## Setup picker

The picker is clack, behind the existing prompt gate (`stdin` and `stdout` TTY, `table`, no `--yes`).

Entry points:

1. `dashboard` with no `[tracking]`, no `--view`, and no `--subject` offers setup, saves `[tracking]`, then renders.
2. `dashboard add` adds subjects and saves `[tracking]` (and any new `[[subjects]]`); the bare form runs the add picker.
3. `track edit` runs the picker and saves `[tracking]`.
4. `track view save <name>` without `--item` runs the picker and saves the view.

Default-selection flow:

1. `multiselect` subjects, prefilled from `[tracking]`, with last-run hints.
2. For each selected repository, `multiselect` stars/forks, both preselected.
3. Accounts skip step 2; `followers` is fixed.
4. Confirm, then write the config atomically.

Add flow:

1. Select type: User or Repository. Accounts use `followers` and skip the metrics prompt.
2. Repository input accepts `owner/name` (one repository) or a bare owner (browse).
3. Browsing lists the owner's public repositories from `GET /users/{owner}/repos`, paginated and sorted by updated. Forks are marked; already-tracked repositories show their current metrics. The user multi-selects.
4. For each selected repository, `multiselect` stars/forks, seeded from `--metrics`, the existing `[tracking]` metrics, or both.
5. Write the config atomically. There is no separate confirmation; cancelling or `Ctrl-C` writes nothing.

Repository listing uses `--token` or the env var named by `defaults.token_env`. On `403`, `404`, a network failure, or an empty list, the command warns and asks for `owner/name` manually.

A view save adds layout (`compact` / `columns`) and compare-from (`previous observation` / custom date). Supplying `--layout` / `--from` / `--to` skips the corresponding prompt.

When the gate is closed, `dashboard` with no selection renders every configured subject with defaults. `dashboard add` without a TTY exits `2` with the non-interactive invocation, while its explicit forms (`add user <login>`, `add repo <owner/name>`, `add <subject>`) run without prompting. `Ctrl-C` exits `130`; declining writes nothing. `--setup` is removed and exits `2` with a message pointing at `dashboard add`.

## Config

```toml
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

- `[tracking]` is the unnamed default selection.
- `[views]` stores full snapshots: items, layout, and range. A view is authoritative; it does not inherit metrics from `[tracking]`.
- Both tables reference configured `[[subjects]]`. A stale reference is a `config_invalid`; `watch rm` removes the reference.
- Metrics are non-empty, valid for the subject kind, and stored in canonical order.

## Observation model

For each selected subject:

1. Every complete raw run containing the subject is an observation at `finishedAt`.
2. A compacted history row is an observation only for a day with no raw observation. Raw wins.
3. Compacted observations have `finishedAt: null` and use the UTC date as `id`.

Resolution:

- `--to` (default `latest`) is an upper bound per subject: `latest` is unbounded, a day or offset is end of day, a run id is that run's finish time.
- `--from` (default `previous`) selects the observation immediately before the row's chosen `to`. Explicit day, offset, or run-id refs are upper bounds; a day or offset older than the subject's data snaps to its oldest observation. `--from latest` uses the same observation as `to`, so deltas are zero.
- `delta = to − from`. A row without a baseline omits the delta and renders `—` in `SINCE`.
- Row `source` is `raw`, `compacted`, `mixed`, or `null` when the row has no `to` observation (never fetched or outside the range).
- Repository observations require both stars and forks; incomplete payloads are skipped.

A run-id reference must name a complete run on disk, matching diff. It bounds every subject by that run's timestamp even when the subject was not part of it.

## Rendering

Default `compact`:

```
gh-track dashboard — my-repos (from 2026-09-01 to latest)

NAME           METRICS                                 SINCE
octocat                        followers 1,204~  (+9)  2026-09-01
  hello-world  stars   132  (+12)  forks     4   (+1)  2026-10-17
  spoon-knife  stars    48   (−2)  forks     1    (0)  2026-10-17
never/fetched                                —         —

~ compacted history
```

`columns`:

```
Repositories
NAME                 STARS      FORKS   SINCE
octocat/hello-world  132 (+12)  4 (+1)  2026-10-17

Accounts
NAME     FOLLOWERS    SINCE
octocat  1,204~ (+9)  2026-09-01
```

- The compact layout renders every selected metric of a subject on one line, in the fixed order `stars`, `forks`, `followers`, separated by two spaces. `NAME` and `SINCE` appear once per subject.
- In `compact`, a repository whose owner is also a selected account is nested under that account. The group sits at the earliest selection position of any member; the account renders first, then its repositories in selection order, each indented two spaces with the `owner/` prefix removed. Owner matching is case-insensitive. Repositories without a selected owner keep their full name and their place in the selection.
- `columns` keeps its separate Repositories and Accounts sections and always renders full names, since a repository there cannot sit directly under its account. JSON rows keep selection order and full `subject` values in both layouts.
- Compact metric values are right-aligned within the `METRICS` column; the header stays at the column's left edge. Each metric keeps a variable-width label (`stars`, `forks`, `followers`) followed by count and delta fields that are exactly as wide as the largest formatted value or delta in the list. The count field is at least one character so `—` still fits, and the delta field collapses to zero when no row has a baseline. Values widen their fields instead of truncating.
- When any displayed value is compacted, the `~` marker has its own one-character slot after the count, so compacted and raw values keep the same count and delta alignment. A list with no compacted values does not reserve the slot.
- A value without a baseline leaves the delta slot blank; a subject with no observation at all renders one `—` in the metrics block and `—` in `SINCE`.
- Repository names and section headers are bold light blue (`1` + `94`); accounts are bold purple (`1` + `95`). Names are not prefixed with `@` in either layout; color carries the kind.
- Values are bold. `(+n)` is green, `(−n)` is red, `(0)` is dim.
- `SINCE` and the compacted `~` marker are dim. `~` is a literal character and survives `NO_COLOR`.
- Number formatting uses deterministic thousands separators, not locale.
- Empty sections and unselected metric columns are omitted.
- No totals, averages, or leaderboards.

`output/table.ts` measures the plain text of a styled cell and paints it on render, so ANSI codes do not break alignment. It also supports per-column alignment and trims trailing whitespace.

## JSON

`dashboard --format json` emits one document. `source` is per row because each subject resolves its own observations.

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

A never-fetched row carries `source: null`, `from: null`, `to: null`, and `{value: null, from: null, delta: null}` per metric. `view` is absent when the default selection is used.

## Non-goals

- Advanced TUI features beyond navigation, live search, copy, add, and refresh (for example, configurable keymaps or multi-select actions).
- Web UI, server, scheduling, alerts, or notifications.
- Totals and rollups (D009).
- Metrics beyond stars, forks, and followers.
- Cross-machine sync.
- Private repositories.

## Open questions

None. The four questions from the draft are resolved by D023:

1. Compaction width: not widened; the dashboard uses the narrow metric set.
2. Retroactivity: selections are display filters and apply to all stored data.
3. Default when no selection exists: setup picker when interactive; all configured subjects with defaults otherwise.
4. Per-subject metrics vs named views: both. `[tracking]` is the default; named views are full snapshots.

## Related

- [Goal](00_GOAL.md)
- [Architecture](01_ARCHITECTURE.md)
- [Spec](02_SPEC.md)
- [Decisions](03_DECISIONS.md)
