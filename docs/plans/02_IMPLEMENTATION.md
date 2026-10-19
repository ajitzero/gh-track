---
title: "02 — Implementation"
type: plan
status: active
updated: 2026-10-20
---

# 02 — Implementation

Execution plan for v1 (`0.1.0`). Contracts are in [01_SPEC.md](01_SPEC.md); this document covers order of work, file layout, and acceptance criteria.

## Progress

- **M1 — done (2026-10-20).** Skeleton, `config.ts`, `store/paths.ts`, `help.ts`, `watch add|ls|rm`, prompt gate and clack wrappers, offline tests.
- **M2 — done (2026-10-20).** `github/client.ts`, `github/etag.ts`, `github/rateLimit.ts`, the `followers`/`repos`/`repo` URL builders, `store/state.ts`, `store/runs.ts`, and `fetch --dry-run`.
- **M3 — done (2026-10-20).** `store/runWriter.ts`, `store/manifest.ts`, `store/lock.ts`, real `fetch` with conditional requests, complete/partial promotion, `pending` tracking, `--resume`, `runs ls|show|paths`, and `watch ls` last-run summaries.
- **M4 — done (2026-10-20).** `store/history.ts`, `store/compact.ts`, `store/prune.ts`, `compact` with `--dry-run`/`--keep-days`, automatic compaction and pruning after complete fetches, `--no-compact`/`--keep-raw-days`, and `export` as JSON, JSONL, or CSV from compacted history.
- **M5 — done (2026-10-20).** `diff/resolve.ts`, `diff/repos.ts`, `diff/followers.ts`, `diff/compacted.ts`, and `diff` with `latest`/`previous`/run-id/date references, id-based rename detection, scalar field deltas, named follower churn, compacted-history fallback, subject filtering, and table/JSON output.
- **M6 — not started.** Hardening, docs, and final acceptance.

## Constraints

- Bun is the package manager and dev runner. Do not add npm scripts or a `package-lock.json`.
- The shipped CLI runs on **Node >= 20**. No `bun:*` imports in `src/` or `test/`.
- ESM only. `package.json` changes from `"type": "commonjs"` to `"type": "module"`.
- Runtime dependencies: `@clack/prompts`, `smol-toml`. Dev: `typescript`, `@types/node`. Nothing else without updating [03_DECISIONS.md](03_DECISIONS.md).
- No database, no ORM, no HTTP client library, no test framework.
- Do not implement the dashboard. See [04_DASHBOARD.md](04_DASHBOARD.md).
- `follow-back.js` is untouched legacy.

## Target `package.json`

Versions are resolved at implementation time; do not guess exact numbers in advance.

```json
{
  "name": "gh-track",
  "version": "0.1.0",
  "description": "Track GitHub metadata with an offline history.",
  "type": "module",
  "private": true,
  "bin": { "gh-track": "dist/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "bun run src/cli.ts",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsc -p tsconfig.test.json && node --test \"dist-test/test/**/*.test.js\"",
    "test:unit": "tsc -p tsconfig.test.json && node --test \"dist-test/test/unit/**/*.test.js\""
  },
  "dependencies": {
    "@clack/prompts": "<latest>",
    "smol-toml": "<latest>"
  },
  "devDependencies": {
    "typescript": "<latest>",
    "@types/node": "<latest>"
  }
}
```

Keep `keywords`, `license`, and `author` as they are. Add `"files": ["dist"]` when publishing; not required for v1.

The test scripts pass a quoted glob rather than the bare `dist-test/test` directory: Node >= 21 no longer expands a directory argument for `--test`. See [D016](03_DECISIONS.md).

## TypeScript config

`tsconfig.json` (build):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`tsconfig.test.json` extends it with `rootDir: "."`, `outDir: "dist-test"`, and `include: ["src/**/*.ts", "test/**/*.ts"]`. Tests import source as `../src/...js` so the compiled layout resolves under `dist-test/`.

`src/cli.ts` starts with `#!/usr/bin/env node`; `tsc` preserves it. Do not add a `chmod` build step — Bun sets the executable bit on install, and `node dist/cli.js` works regardless.

## File layout

```
src/
├── cli.ts                  entry, global flags, dispatch, exit-code mapping
├── help.ts                 command registry, help renderer
├── config.ts               TOML load/validate/save
├── errors.ts               typed errors + error codes
├── types.ts                Subject, RunManifest, Resource, Diff types
├── commands/
│   ├── fetch.ts
│   ├── watch.ts
│   ├── runs.ts
│   ├── diff.ts
│   ├── compact.ts
│   ├── export.ts
│   └── help.ts
├── prompts/
│   ├── gate.ts             TTY/format/--yes detection
│   └── index.ts            clack wrappers
├── github/
│   ├── client.ts           request(), retries, timeout, headers, token
│   ├── etag.ts             ETag cache read/write, 304 resolution
│   ├── rateLimit.ts        header parsing, budgets, cache
│   └── resources/
│       ├── followers.ts
│       ├── repos.ts
│       └── repo.ts
├── store/
│   ├── paths.ts            XDG resolution, run paths, locks
│   ├── state.ts            ETag/rate-limit cache persistence (reads tolerant, writes atomic)
│   ├── runs.ts             read a stored run payload
│   ├── runWriter.ts        temp dir, atomic rename, file writes
│   ├── manifest.ts         create/read/update manifests
│   ├── history.ts          NDJSON read/upsert/sort
│   ├── compact.ts          day selection, metric extraction
│   ├── prune.ts            retention deletion
│   └── lock.ts             pid lock
├── diff/
│   ├── resolve.ts          refs → runs
│   ├── repos.ts            id matching, scalar field diff
│   ├── followers.ts        set diff
│   └── compacted.ts        history-based fallback
└── output/
    ├── table.ts            minimal column renderer
    ├── json.ts             single-document serializer
    └── color.ts            NO_COLOR-aware helpers
```

```
test/
├── unit/                   config, subjects, paths, help, rate limit, etag, diff, compaction
├── integration/            fetch with fake client, resume, prune, export, prompts gate
└── fixtures/
    ├── followers-page-1.json
    ├── followers-page-2.json
    ├── repos-page-1.json
    ├── repo.json
    └── errors/{403-primary.json,429-secondary.json,404.json}
```

## Design requirements

- **Inject `fetch`.** `GitHubClient` takes `{ fetchImpl = globalThis.fetch, now = Date.now, sleep }` so tests are deterministic and offline.
- **No global state.** Paths, config, and caches are passed explicitly. This makes XDG and `--data-dir` testing trivial.
- **Errors are typed.** Each domain error carries a spec code (`config_invalid`, `rate_limited`, ...). `cli.ts` maps them to exit codes once.
- **Output is constructed, not printed ad hoc.** Commands return a result object; `output/` renders it as table or JSON. This is what guarantees JSON purity.
- **Every filesystem write is atomic.** Temp file in the destination directory, then rename.
- **Time is injectable** anywhere retention or run IDs are computed.

## Milestones

### M1 — Skeleton, config, watchlist, help

Deliver:

- `package.json`, `tsconfig*.json`, directory skeleton, `.gitignore` already present.
- `config.ts`: parse/validate/write TOML; defaults; deduplication.
- `paths.ts`: XDG resolution and `--data-dir`/`--config` overrides.
- `help.ts` registry + renderer with optional examples.
- `watch add|ls|rm` without last-run data.
- Prompt gate and clack wrappers.

Acceptance:

- `bun run dev -- --help`, `... fetch --help`, `... watch add --help` all render and exit `0`.
- `watch add user octocat` creates a valid TOML file atomically.
- `watch ls --format json` is one valid JSON document; no stderr noise.
- Unknown command exits `2`; invalid config exits `2` with `config_invalid`.
- No network access in any M1 path.

### M2 — GitHub client, rate limit, ETags, fetchers

Deliver:

- `client.ts`: headers, token, timeout, retries, pagination helper.
- `etag.ts` and `rateLimit.ts` with persisted state.
- `followers`, `repos`, `repo` fetchers.
- `fetch --dry-run` plan output.

Acceptance:

- Unit tests cover `200`, `304`, `403` primary limit, `429` with `Retry-After`, `404`, `5xx`, malformed JSON.
- Pagination follows `Link` and falls back to short-page detection.
- A `304` resolves to the previous run's stored payload.
- `--dry-run` spends no quota and writes nothing, and its JSON matches §5.8.
- The effective cap never exceeds `remaining - 2`, and `--max-requests` can only lower it.

### M3 — Run writer, manifests, partial runs, resume

Deliver:

- `runWriter.ts`, `manifest.ts`, `lock.ts`.
- Complete/partial promotion, `pending` tracking, `--resume`.
- `runs ls|show|paths`.
- `watch ls` last-run summary.

Acceptance:

- A completed run appears atomically; no `.tmp-*` remains.
- Killing a run at any request leaves a resumable partial run; `--resume` fetches only pending requests.
- A second concurrent `fetch` exits `1` with `locked`; a stale lock is reclaimed.
- `SIGINT` promotes a partial run and exits `130`.
- Manifest matches §5.1 exactly enough to be machine-read.

### M4 — Compaction, pruning, export

Deliver:

- `history.ts`, `compact.ts`, `prune.ts`, `export`.
- Automatic compaction/pruning after complete fetches.
- `--no-compact`, `--keep-raw-days`, `compact --dry-run`.

Acceptance:

- A day is compacted only when older than retention and containing a complete run.
- The last complete run of the day wins.
- Only compacted days are pruned; partial-only days are retained.
- Re-running compaction is idempotent (one line per date).
- Prune refuses paths that do not match the run-id pattern.
- `export` emits valid `json`, `jsonl`, and `csv` with the specified columns.

### M5 — Diff

Deliver:

- Reference resolution (`latest`, `previous`, run id, date).
- Repo diff by `id` with rename detection, scalar field diffs, added/removed.
- Follower set diff with named additions/removals.
- Compacted-history fallback with the documented field limits.
- Table and JSON renderers.

Acceptance:

- Exact star and fork before/after values and deltas match fixtures.
- A renamed repository yields one `renamed` entry.
- Follower additions/removals are named, case-insensitive, and stable.
- Diffs touching compacted history set `source` and suppress identities with `identitiesAvailable: false`.
- `--subject` filtering works for both subject types.
- No files are written.

### M6 — Hardening and docs

Deliver:

- Full offline test suite, README quickstart, manual QA pass.
- Update plan statuses (`01_SPEC.md`, `02_IMPLEMENTATION.md`, `03_DECISIONS.md`) and `AGENT.md` status line.

Acceptance:

- `bun run typecheck`, `bun run build`, `bun run test` all pass with no live network.
- `grep -R "bun:" src test` returns nothing.
- JSON purity test: run every JSON-capable command with a fake TTY and assert stdout parses as one document with no ANSI.
- `node dist/cli.js --help` works on a clean Node 20 install.
- Manual QA: fresh data dir, no config, no token, small watchlist, rate-limit simulation, resume, compact, diff.

### M7 — Interactive first-run setup (post-v1 enhancement)

A new user with no config should not hit a dead end. Milestones M1-M6 treat a missing config as `config_missing` and exit `2`. This milestone adds an opt-out, interactive onboarding path on top of the existing watchlist commands. It is deliberately last: it depends on the prompt gate and clack wrappers from M1, on `fetch` from M2/M3, and on `watch ls` last-run data from M3.

Deliver:

- Extend the interactive `watch add` flow (no arguments) into a full setup wizard: type picker (`user` / `repo`), name input, and — for users only — a resource multi-select (`followers`, `repos`) with both preselected and at least one required. `repo` subjects skip the resource step and use the implicit `repo` resource. The existing select-then-text-then-confirm flow is extended, not replaced.
- First-run trigger: when a command that needs the watchlist runs with no config and prompts are allowed, offer to create one using the same wizard, then continue the original command.
  - `watch ls` → wizard, then list the new subject.
  - `fetch` with no subject arguments → wizard, then proceed to the fetch plan.
  - `watch rm` and `fetch <subject>` do not trigger it; `runs`, `diff`, `compact`, `export`, `help`, and `--version` are unaffected.
- Reuse the atomic config write from `watch add`; no partial config is written on cancel.
- `--resources` on `watch add` suppresses the resource multi-select and uses the given value.
- `config_missing` keeps its current meaning and message when the wizard is not allowed, with the message extended to include the exact non-interactive invocation.

Gate (unchanged rules; when not met, fail as today with `config_missing`, exit `2`):

- Wizard runs only when `stdin.isTTY && stdout.isTTY`, format is `table`, and `--yes` is absent. `--format json` is always non-interactive.
- Declining the wizard aborts it and lets the original command fail with `config_missing` (exit `2`); it is not treated as success. `Ctrl-C` exits `130` and applies no partial confirmation.
- An existing but empty watchlist is **not** a trigger. `fetch` with no arguments keeps exiting `2` with `empty_watchlist`, and `watch ls` keeps reporting that no subjects are configured.

Acceptance:

- On a clean machine with no config, in a TTY: `watch ls` offers setup; completing the wizard writes a valid config atomically and then lists the new subject.
- `fetch` with no arguments on a clean machine offers setup and continues to the request plan after completion.
- `watch add` with no arguments walks type → name → resources (user) and type → name (repo), then confirms.
- `watch add user octocat --resources followers` does not prompt for resources.
- In `--format json`, without a TTY, or with `--yes`, every command still exits `2` with `config_missing` and prompts nothing.
- Declining the wizard exits `2` with `config_missing`; `Ctrl-C` exits `130`; no `.tmp-*` or partial config remains either way.
- JSON purity test from M6 still passes for every command.
- No new dependencies; `grep -R "bun:" src test` still returns nothing.

Spec changes to apply when this milestone is implemented:

- [01_SPEC.md](01_SPEC.md) §2.2: document the resource multi-select in the interactive `watch add` flow.
- §2.1 and §4: note that a watchlist-requiring command may offer first-run setup instead of `config_missing`, and that the failure is unchanged when the gate is not met.
- §7: add the first-run setup rows to the prompt table; `fetch` may now ask a question when it has no config and no subject arguments.
- [03_DECISIONS.md](03_DECISIONS.md): the decision is recorded as D017; amend it if the design changes.

## Test fixtures

Fixtures are recorded public payloads with identities altered where necessary. Each fixture set contains at least:

- A user with 150 followers across two pages (tests pagination).
- A user with 3 repositories, one renamed between runs, one archived between runs.
- A standalone repository.
- Follower churn: one added, one removed.
- Error responses listed above.

No test may read the network. Integration tests use an in-memory `fetchImpl` and a temp directory created under the OS temp dir, not the repo.

## Handoff notes for implementing agents

1. Implement milestones in order. Do not start M6 before M5 is stable.
2. Treat [01_SPEC.md](01_SPEC.md) as the contract. If it is wrong, amend it and log the change; do not silently deviate.
3. Keep `src/github` free of filesystem imports; keep `src/store` free of HTTP imports.
4. Return structured results from commands; render only in `src/output`.
5. Do not add dependencies beyond the two runtime packages without a decision-log entry.
6. Do not add a dashboard, scheduler, token prompt, keyring, database, or background process.
7. Do not commit anything under the XDG data directory or any fixture generated by a live run.
8. Leave `follow-back.js` alone.

## Definition of done

- All milestone acceptance criteria pass.
- Every command in [01_SPEC.md §2](01_SPEC.md) is implemented or explicitly descoped in the decision log.
- JSON output and exit codes match the spec.
- Help works at root, command, and subcommand levels.
- `AGENT.md` and plan statuses reflect reality.
- No live-network dependency in the test suite.

## Deferred beyond v1

- Interactive dashboard and metric picker ([04_DASHBOARD.md](04_DASHBOARD.md)).
- Interactive first-run setup for users with no config (M7).
- Required or stored authentication, keyring integration, private repositories.
- Gzip-compressed raw runs (raw is retained only 30 days, so the size is bounded).
- Starred-list tracking.
- Scheduling helpers (`--if-due`, systemd/cron examples).
- Multi-machine sync.

## Related

- [Architecture](../01_ARCHITECTURE.md)
- [Spec](01_SPEC.md)
- [Decisions](03_DECISIONS.md)
