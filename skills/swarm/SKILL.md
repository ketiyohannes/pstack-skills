---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

In Claude Code, read [the Claude Code adapter](../../docs/harness/claude-code.md) once per session before you follow this skill. It maps the Cursor names in pstack skills to Claude Code.

## In Claude Code

Run Phases B and C as the `pstack:swarm` workflow. Do Phase A yourself, then call `Workflow` with `name: "pstack:swarm"` and these `args`:

- `pstackRoot`, `goal`, `donePredicate`, and `shape` (`coverage`, `race`, or `mixed`).
- `raceRule` (`first pass`, `rank all`, or `best-of`). Required for a race or mixed shape.
- `workers`, one `{id, brief}` per slice or race arm. Every brief stands alone. Add `model` and `effort` to an arm for a model race.
- `defaultWorker` from the `swarm workers` line.
- `isolation: "worktree"` when workers write.
- `requireShas` and `requireMethod` when the briefs require them. The workflow respawns a worker once when its result leaves them out, then records a gap.

`pstackRoot` is the absolute path of the folder that holds `skills/`, two levels up from this file. Take each model from its role line in `~/.claude/rules/pstack-models.md` as `{model, effort}`, for example `opus xhigh` as `{"model": "opus", "effort": "xhigh"}`. Leave a role out when its line is missing, and the workflow uses its default. Write `inherit-parent` or `auto` as `{"model": "inherit"}`. A Cursor-only slug such as `grok-*` has no Claude Code model, so leave that role out too. Workflow subagents are all Claude models, so a cross-family check becomes a cross-model check. Say so in the output. If the session has no `Workflow` tool, follow the Cursor steps below with the adapter.

The workflow returns `rows`, `gaps`, and the race `selection`. Write the Phase D report from them.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Pick the worker model from the `swarm workers` line in `~/.cursor/rules/pstack-models.mdc`. If the rule or that line is missing, use `grok-4.7-xhigh-fast`. For `auto` or `inherit-parent`, omit `model` so the workers run on the parent model. If the Task tool rejects a slug, use the default and say so. If it rejects the default, use the closest valid slug of the same family from its error message. For a model race, name each arm's model up front. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message with `subagent_type: generalPurpose`, `environment: "cloud"`, `run_in_background: true`, and the step 3 model, left unset for `auto` or `inherit-parent`. Use `environment: "local"` only when the worker needs access to something on the user's computer.

When a worker must start from a non-default pushed branch, pass `cloud_base_branch`.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.
