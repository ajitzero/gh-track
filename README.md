# gh-track

Track public GitHub metadata with an offline history.

`gh-track` snapshots watched accounts and repositories on demand, keeps immutable runs on disk, compacts old runs into a small daily history, and reports exact repository and follower changes between two points in time. It works without a token.

## Quickstart

Requires [Bun](https://bun.sh/) for development and Node.js >= 20 to run the built CLI.

```bash
bun install
bun run build

# One-time only: Make the command available locally
bun link

# Optional: watch an account and one repository
gh-track watch add user octocat
gh-track watch add repo torvalds/linux

# Fetch every configured subject
gh-track fetch

# See what changed since the previous complete run
gh-track diff

# Compare against a rolling window (offsets: d, w, m, y)
gh-track diff --from 1y --to latest
```

`fetch` also accepts explicit subjects without touching the config:

```bash
gh-track fetch user:octocat
gh-track fetch torvalds/linux --dry-run
gh-track fetch https://github.com/torvalds/linux
```

Everywhere a subject is accepted, a GitHub profile or repository URL works too:
`https://github.com/octocat` is a user, and
`https://github.com/octocat/hello-world` is a repository.

The first run creates the data directory. The default locations are:

| Purpose | Default                                               |
| ------- | ----------------------------------------------------- |
| Config  | `~/.config/gh-track/config.toml` (`$XDG_CONFIG_HOME`) |
| Data    | `~/.local/share/gh-track` (`$XDG_DATA_HOME`)          |

Use `--config <path>` and `--data-dir <path>` to override them.

## Commands

| Command                                                             | Purpose                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `watch add user <login> [--resources followers,repos]`              | Add or update a watched account                                    |
| `watch add repo <owner/name>`                                       | Add or update a watched repository                                 |
| `watch ls`                                                          | Show the watchlist and each subject's last run                     |
| `watch rm <subject> [--yes]`                                        | Remove a subject                                                   |
| `fetch [subject...]`                                                | Fetch and snapshot current data                                    |
| `fetch --dry-run`                                                   | Print the request plan without spending quota                      |
| `fetch --resume [<run-id>]`                                         | Continue a partial run                                             |
| `runs ls [--limit <n>]`                                             | List stored runs                                                   |
| `runs show <run-id>`                                                | Show a run manifest                                                |
| `runs paths <run-id>`                                               | Print a run directory                                              |
| `diff [--from <ref>] [--to <ref>]`                                  | Compare two points in time (`1y` past offsets supported)           |
| `compact [--dry-run]`                                               | Roll old runs into daily history                                   |
| `export [--format json\|jsonl\|csv]`                                | Export compacted history                                           |
| `dashboard [--view <name>]`                                         | Show selected metrics and per-subject deltas (default command)     |
| `dashboard add [user <login> \| repo <owner/name> \| repo <owner>]` | Add and watch subjects; an owner browses their public repositories |
| `track edit`                                                        | Pick subjects and metrics interactively                            |
| `track set --item <subject>=<metrics>`                              | Set a subject's dashboard metrics                                  |
| `track rm <subject>`                                                | Remove a subject from the default selection                        |
| `track ls`                                                          | Show the default selection and saved views                         |
| `track view save <name>`                                            | Save a named dashboard snapshot                                    |
| `track view rm <name>`                                              | Remove a saved dashboard snapshot                                  |

Run `gh-track` with no command to render the dashboard, or `gh-track help` / `gh-track <command> --help` for the full option reference.

## Dashboard

`dashboard` is a read-only value view over the same data as `diff`. Metrics are fixed: stars and forks for repositories, followers for accounts. Each row compares against that subject's own previous observation, so subjects fetched at different times keep their values.

```bash
# The dashboard is the default command
gh-track

# Add and watch subjects interactively (user or repository)
gh-track dashboard add

# Or non-interactively
gh-track dashboard add user octocat
gh-track dashboard add repo torvalds/linux --metrics stars,forks

# Browse an owner's public repositories and pick several at once
gh-track dashboard add repo octocat

# Save a named snapshot with its own layout and range
gh-track track view save my-repos --item repo:torvalds/linux=stars \
  --layout columns --from 2026-09-01
gh-track dashboard --view my-repos
```

`dashboard add` writes both the watchlist and the default selection, so the next `fetch` picks the subject up. It only adds: use `track rm` to remove a subject and `track edit` to replace the whole selection.

Selections live in `[tracking]`; named views live in `[views]` in the same TOML file. A compacted-history value carries a `~` marker, and `--format json` returns per-row `source` values (`raw`, `compacted`, `mixed`, or `null`).

## Configuration

`watch add` creates and updates the TOML config atomically. A minimal file looks like this:

```toml
schema_version = 1

[defaults]
raw_retention_days = 30
request_timeout_ms = 30000
max_retries = 3

[[subjects]]
type = "user"
account = "octocat"
resources = ["followers", "repos"]

[[subjects]]
type = "repo"
repo = "torvalds/linux"
```

A token is optional. Pass `--token <token>` or set the environment variable named by `defaults.token_env`; tokens are never written to disk.

## JSON output

Every command except `help` accepts `--format json`. JSON mode writes exactly one document to stdout. Warnings and errors go to stderr; errors are a single JSON document as well.

```bash
gh-track diff --format json | jq '.repos[] | {repository, fields}'
gh-track export --format jsonl > history.jsonl
gh-track export --format csv > history.csv
```

`export` reads compacted history only. `diff` uses raw runs while they exist and falls back to compacted days for older points.

## Retention

Raw runs are kept for 30 days by default. After each complete fetch, `gh-track` compacts eligible UTC days into `history/` and prunes their raw run directories. Use `--no-compact` to skip this on a fetch, or `--keep-raw-days <n>` to override the window for one run.

Compacted days retain repository stars and forks plus account follower counts. Repository ids, renames, other scalar fields, and follower identities are unavailable after raw data is pruned. `diff` reports this as `source: "compacted"` or `"mixed"`.

## Data layout

```text
~/.local/share/gh-track/
├── runs/<run-id>/          # immutable raw snapshots
├── history/                # compacted NDJSON history
├── state/                  # ETag, rate-limit, and compaction caches
└── locks/                  # fetch lock
```

Run ids are ISO-8601 UTC timestamps. Raw API payloads live under each run; see the [Architecture](docs/01_ARCHITECTURE.md) for the full tree.

## Development

```bash
bun run dev -- --help
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test
```

The test suite is fully offline: HTTP is injected, and every filesystem test uses a temporary directory. There are no live-network tests.

- [Goal](docs/00_GOAL.md)
- [Architecture](docs/01_ARCHITECTURE.md)
- [Spec](docs/02_SPEC.md)
- [Decisions](docs/03_DECISIONS.md)
- [Dashboard](docs/04_DASHBOARD.md)
