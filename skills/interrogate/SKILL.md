---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Adversaries try to break a change or design, and only findings proven by a run survive."
disable-model-invocation: true
---

# Interrogate

In Claude Code, read [the Claude Code adapter](../../docs/harness/claude-code.md) once per session before you follow this skill. It maps the Cursor names in pstack skills to Claude Code.

## In Claude Code

Run Fan out and Verify as the `pstack:interrogate` workflow. Do Frame yourself. Save the scope's uncommitted changes with `git diff --binary --output=/tmp/pstack-interrogate-<slug>.patch HEAD`, and confirm the file is a real patch with `git apply --check -R <that path>`. Write it with `--output`, not a shell redirect, because a shell hook that rewrites `git` output can corrupt a redirected diff. Then call `Workflow` with `name: "pstack:interrogate"` and these `args`:

- `scope` and `intent` (the restatement).
- `patchPath`, the saved diff. Leave it out when the scope is already committed. Use `ref` when adversaries must check out a branch or SHA.
- `adversaries` from the `interrogate reviewers` line, and `verifier` from the `swarm workers` line.

`pstackRoot` is the absolute path of the folder that holds `skills/`, two levels up from this file. Take each model from its role line in `~/.claude/rules/pstack-models.md` as `{model, effort}`, for example `opus xhigh` as `{"model": "opus", "effort": "xhigh"}`. Leave a role out when its line is missing, and the workflow uses its default. Write `inherit-parent` or `auto` as `{"model": "inherit"}`. A Cursor-only slug such as `grok-*` has no Claude Code model, so leave that role out too. Workflow subagents are all Claude models, so a cross-family check becomes a cross-model check. Say so in the output. If the session has no `Workflow` tool, follow the Cursor steps below with the adapter.

Each adversary works in its own worktree and returns every repro file with its finding. A separate verifier re-runs each finding in a fresh worktree with the same setup, and only re-run failures that break the intent come back as `verified`. Merge verified findings that share a root cause, then write the Output section. Report `rejected` as the dropped count and reasons. An adversary with `inconclusive` set never attacked the change. When `inconclusive` is true for the whole run, report the run as inconclusive with each reason, never as "no verified findings". After you report, remove the run's worktrees with `git worktree remove --force` on each path under `.claude/worktrees/` whose name starts with the run ID, then `git worktree prune`.

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill, from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Fan out

Run Phase A steps 3 and 4 and Phase B of the **arena** skill, with four changes. Read the `interrogate reviewers` line in place of `arena runners`. Copy the scope's uncommitted changes into each worktree. Spawn each adversary as `generalPurpose`. In place of the arena task and rationale, give each adversary the scope, the intent, and this brief:

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

## Verify

Verify each finding per arena Phase F by rerunning its command. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

Skip arena Phases C, D, and E. Adversaries find different failures, so the verdict keeps every verified finding, not one adversary's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the adversaries that found it. Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.
