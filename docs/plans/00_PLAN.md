---
title: "00 — Plans"
type: plan
status: active
updated: 2026-10-19
---

# 00 — Plans

Folder metadata. This file never contains project requirements.

## What lives here

Plans are working documents under `docs/plans/`. The stable, conceptual docs live one level up:

- [Goal](../00_GOAL.md) — why the project exists and what success means.
- [Architecture](../01_ARCHITECTURE.md) — how the system is structured.

Plans hold the executable detail: contracts, milestones, decisions, and deferred work.

## Numbering

- `00_` is reserved for this file at every level and is never reused.
- Plans start at `01_`. Take the next free number; never renumber an existing plan.
- Prefix the filename with the number and use a short `SCREAMING_SNAKE_CASE` topic: `01_SPEC.md`, `02_IMPLEMENTATION.md`.
- Numbers are identity, not priority.

## Status

Every plan carries frontmatter:

```yaml
---
title: "01 — Spec"
type: plan
status: active
updated: 2026-10-19
---
```

| Status | Meaning |
|---|---|
| `draft` | Being written or argued; not authoritative |
| `active` | Current and binding |
| `done` | Implemented; kept for history |
| `superseded` | Replaced; link to the replacement |

`docs/` root files use `type: core`; plans use `type: plan`. Do not add tags.

## Adding a plan

1. Pick the next number.
2. Add the frontmatter above with `status: draft`.
3. Link it from the relevant core doc (usually the Goal or Architecture).
4. When the work lands, set `status: done` and update `updated`.

## Current plans

| Plan | Status | Purpose |
|---|---|---|
| [01 — Spec](01_SPEC.md) | active | Exact CLI, config, and output contracts |
| [02 — Implementation](02_IMPLEMENTATION.md) | active | Milestones, file layout, tests |
| [03 — Decisions](03_DECISIONS.md) | active | Decision log and rejected alternatives |
| [04 — Dashboard](04_DASHBOARD.md) | draft | Deferred interactive dashboard and metric picker |
