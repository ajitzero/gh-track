# AGENT.md

Entry point for agents and contributors. Keep this file short; the reasoning lives in `docs/`.

## What this project is

`gh-track` is a local-first CLI that fetches public GitHub REST payloads for watched accounts and repositories on demand, writes immutable timestamped snapshots, compacts old runs into a small history, and derives diffs between runs. It is built for one operator tracking their own account plus arbitrary public accounts.

**Status:** documentation complete, implementation not started. The `src/` tree, `package.json` scripts, and `bin` entry described in the plans do not exist yet. `package.json` is still CommonJS and has no dependencies.

## Read first

1. [docs/00_GOAL.md](docs/00_GOAL.md) — why, success criteria, non-goals.
2. [docs/01_ARCHITECTURE.md](docs/01_ARCHITECTURE.md) — components, storage, rate limits, failure modes.
3. [docs/plans/00_PLAN.md](docs/plans/00_PLAN.md) — how the plans folder works.
4. [docs/plans/01_SPEC.md](docs/plans/01_SPEC.md) — exact CLI, config, and JSON contracts.
5. [docs/plans/02_IMPLEMENTATION.md](docs/plans/02_IMPLEMENTATION.md) — milestones, file layout, tests.
6. [docs/plans/03_DECISIONS.md](docs/plans/03_DECISIONS.md) — why the design looks like this.

Do not start coding from this file alone.

## Commands (target)

Bun is the package manager and dev runner. The shipped CLI must run on Node >= 20.

```bash
bun install
bun run dev -- --help          # runs src/cli.ts directly
bun run typecheck
bun run build                  # tsc -> dist/
node dist/cli.js --help
bun run test                   # compile tests, then node --test on dist-test/
```

There is no npm workflow. Do not add one.

## Project layout (target)

```
src/cli.ts             entry, global flags, dispatch
src/help.ts            command registry + help renderer
src/config.ts          TOML load/validate/save
src/types.ts           shared types
src/commands/          one file per top-level command
src/prompts/           clack wrappers (TTY-gated)
src/github/            client, ETag cache, rate limiter, resource fetchers
src/store/             XDG paths, run writer, manifest, history, prune
src/diff/              repo and follower diffs
src/output/            table, JSON, color
test/                  node:test fixtures, no live network
```

## Invariants

- No `bun:*` imports in `src/`. Use Node built-ins and global `fetch` only.
- `--format json` writes exactly one JSON document to stdout and nothing else. No spinners, colors, banners, or prompts. Diagnostics go to stderr.
- Interactive prompts run only when stdin and stdout are TTYs, the format is `table`, and `--yes` is absent.
- A finished run directory is immutable. Fetch writes to `runs/.tmp-<id>/` and renames it into place.
- Partial runs are resumable and never silently discarded.
- Raw runs are kept 30 days by default. Only days that have been compacted may be pruned.
- No aggregates: report exact per-repo counts, never totals or rollups.
- No database. Plain files under XDG directories.
- Runtime data never lives in the repo and is never committed.
- Config is TOML at `~/.config/gh-track/config.toml`.

## Docs rules

- Everything under `docs/` is an Obsidian vault. Use relative Markdown links (they render on GitHub too); do not use wikilinks.
- Frontmatter keys: `title`, `type` (`core` for `docs/` root, `plan` for `docs/plans/`), `status`, `updated`. Do not add tags.
- Plans are numbered. `docs/plans/00_PLAN.md` is folder metadata and is never repurposed.
- If behavior changes, update `docs/plans/01_SPEC.md` and add an entry to `docs/plans/03_DECISIONS.md`.

## Legacy

`follow-back.js` is an unrelated scratch script. Do not wire it into the CLI, and do not delete it without asking.

## Out of scope for v1

Interactive dashboard and per-item metric picker ([04_DASHBOARD.md](docs/plans/04_DASHBOARD.md)), scheduling, required authentication, private-repo and traffic data, tracking a user's starred list, and totals/rollups.
