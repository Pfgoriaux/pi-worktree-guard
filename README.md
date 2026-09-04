# pi-worktree-guard

> Policy: **one branch = one worktree = one agent.**

Blocks concurrent pi sessions from running each other over on a shared git
checkout. Born from a real incident: a second agent, needing a different
branch, ran `git stash` + `git checkout` in a checkout another agent was
working in — 23 uncommitted paths parked in the stash pile behind a polite
note.

## What it does

1. **Claim** — every pi session whose working directory is a repo's *main*
   checkout writes a claim file under `<repo>/.git/pi-agent-claims/
   <host>-<pid>.json` (branch, pid, heartbeat timestamp). Claims are
   heartbeat-refreshed every 30 s while pi runs, deleted on session
   shutdown, and garbage-collected once their pid is dead or their heartbeat
   is stale (>10 min). Linked worktrees never claim — they cannot collide.

2. **Block** — when a `bash` tool call would run a git op that moves HEAD or
   hides/destroys work **on the main checkout while another live pi session
   holds a claim on it**, the call is blocked. The reason tells the agent
   what to do instead:

   Blocked ops: `git stash` (all mutating forms: bare/`push`/`pop`/`apply`/
   `drop`/`clear`/`save`/`store`/`create`/`branch`), `git checkout`,
   `git switch`, `git reset --hard`, `git clean -f…`.

## What it does NOT block

- Anything inside a **linked worktree** (`herdr worktree create`, `git
  worktree add`) — that's the blessed state, guard steps aside.
- Anything in a repo **no other live session claims** — single-agent flow is
  untouched, routine `git checkout` alone in the main checkout is fine.
- `git stash list` / `git stash show` (read-only), non-`--hard` resets,
  non-forced cleans.
- Commands outside a git repository (git errors on its own anyway).

## Behavior notes

- Command scanning is **best-effort, quote-aware**: `cd`/`pushd` and
  `git -C <path>` are tracked so a command gets evaluated against the
  directory it actually targets — a worktree agent running
  `git -C ../other-project stash` still gets checked, and a main-checkout
  agent running `cd ../other-project-worktree && git checkout` does not.
- **Fail-closed on indirection**: `sh -c '…git stash…'` or `xargs git …`
  in a claimed checkout is blocked even though the scanner cannot parse the
  nested invocation. Parse failures on plain commands fall through to git's
  own errors instead.
- The escape hatch is **human-shaped on purpose**: relaunch pi with
  `PI_WORKTREE_GUARD=0`. Setting it inside a bash tool call only affects
  that subshell, not the guard, so agents cannot disable themselves.
- Claims and check state live under `.git/` — nothing tracked by git, no
  merge noise, no repo pollution.

## Install

In `~/.pi/agent/settings.json`:

```json
{
	"packages": ["../../dev/pi/extensions/pi-worktree-guard"]
}
```

## Companion rules

The AGENTS.md rule this enforces lives in each repo's instructions:
concurrent sessions use worktrees, and work is committed before being
reported done — a stash is not a deliverable.


## The pi extension family

Five packages, one workflow: plan, fan out, review, protect, verify.

| Package | Job |
|---|---|
| [pi-dispatch](https://github.com/Pfgoriaux/pi-dispatch) | parallel sub-agent fan-out, merge-back, Herdr arborescence |
| [pi-feature-swarm](https://github.com/Pfgoriaux/pi-feature-swarm) | read-only multi-model feature discovery & planning |
| [pi-pr-swarm](https://github.com/Pfgoriaux/pi-pr-swarm) | multi-model PR review, then aggregate & fix |
| [pi-worktree-guard](https://github.com/Pfgoriaux/pi-worktree-guard) | one branch = one worktree = one agent |
| [pi-repo-check](https://github.com/Pfgoriaux/pi-repo-check) | repo hygiene gate: conventions, docs-in-pairs, baseline |
