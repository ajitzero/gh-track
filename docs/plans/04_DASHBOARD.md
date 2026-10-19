---
title: "04 — Dashboard"
type: plan
status: draft
updated: 2026-10-19
---

# 04 — Dashboard

Deferred work. Do not build this during v1.

## Goal

A static, CLI-rendered dashboard plus an interactive picker that chooses which subjects and which metrics to display.

The user's framing: once the ingestion infrastructure exists, use `@clack/prompts` to select one or more entities (repositories, users) and, per entity, choose the metrics to track — for example stars only for one repository, stars and forks for another. The dashboard then shows those selections as a table. It is not a full-screen TUI and not interactive after rendering.

## Depends on

- v1 milestones through M6 ([02_IMPLEMENTATION.md](02_IMPLEMENTATION.md)).
- Compacted history (`history/`) and at least two runs for deltas.

## The blocking data question

v1 compacts only `stars`, `forks`, and `followers` ([D007](03_DECISIONS.md)). A dashboard that lets users pick arbitrary metrics therefore has two sources:

| Source | Availability | Metrics |
|---|---|---|
| Raw runs | Last 30 days | Every scalar in the payload |
| Compacted history | Forever | Stars, forks, followers |

If the dashboard offers more than those three metrics, it either restricts itself to the raw window or the compaction schema must be widened **before** users accumulate history. Widening is trivial; backfilling is impossible.

**Decision needed before implementation:** widen compaction now (cheap, future-proof, slightly larger history), or keep the narrow schema and accept that the dashboard is limited to 30 days for other metrics.

## Proposed surface

```
gh-track dashboard                 # render the configured selection
gh-track track edit                # clack: pick subjects, then metrics per subject
gh-track track ls                  # show current selection
```

Non-interactive equivalents for agents:

```
gh-track dashboard --format json
gh-track track edit --subject repo:octocat/hello-world --metrics stars,forks --yes
```

## Proposed config extension

```toml
[tracking."repo:octocat/hello-world"]
metrics = ["stars", "forks"]

[tracking."user:octocat"]
metrics = ["followers"]
```

Quoted keys are required because the subject contains `/` and `:`. The interactive picker writes this section; `track ls` reads it back.

## Rendering

- One row per selected entity.
- Columns: entity, selected metrics with current values, and deltas against the previous run or a chosen date range.
- `--since <date>` / `--from` / `--to` reuse the diff reference resolution.
- `--format json` returns the same rows as structured data.
- Values older than the raw window are marked as compacted.

Example:

```
Repository                  Stars            Forks        Since
octocat/hello-world         132 (+12)        4 (+1)       2026-10-18
octocat/spoon-knife         48 (−2)          1 (0)        2026-10-18
```

## Non-goals

- Full-screen TUI (no alternate screen, no keybindings).
- Web UI or server.
- Alerts, notifications, or scheduled reports.
- Aggregates and totals ([D009](03_DECISIONS.md)); if a total is ever added, it is a new decision.
- Cross-machine sync.

## Open questions

1. Widen the compacted history schema? See above.
2. Should selections apply retroactively to existing history, or only to future runs? (They are display filters, so they should apply to any stored data.)
3. Should the dashboard default to all configured subjects when no `[tracking]` entries exist?
4. Is a per-subject metric selection the right model, or are named "views" (for example "my repos", "competitors") more useful?

## Related

- [Goal](../00_GOAL.md)
- [Spec](01_SPEC.md)
- [Decisions](03_DECISIONS.md)
