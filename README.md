# pi-worktree-guard

> Workflow goal: one branch and one worktree per agent.
> The implementation guards selected Git operations on shared main checkouts;
> it does not enforce exclusive access to every worktree.

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
   is stale (>10 min). Linked worktrees do not claim; users must assign a
   distinct worktree to each agent to avoid collisions there.

2. **Block** — when a `bash` tool call would run a git op that moves HEAD or
   hides/destroys work **on the main checkout while another live pi session
   holds a claim on it**, the call is blocked. The reason tells the agent
   what to do instead:

   Blocked ops: `git stash` (all mutating forms: bare/`push`/`pop`/`apply`/
   `drop`/`clear`/`save`/`store`/`create`/`branch`), `git checkout`,
   `git switch`, `git reset --hard`, `git clean -f…`.

3. **Location** — `git worktree add <path>` is blocked for a repo inside the
   workspace unless `<path>` sits under the repo's mirrored folder. The
   workspace is the parent of `PI_WORKTREE_ROOT` (default `~/eden/.worktrees`),
   so `~/eden/products/app` gets worktrees under
   `~/eden/.worktrees/products/app/<branch>`, with `/` in the branch replaced
   by `-`. The block reason gives the exact command to run instead. This
   applies to every session, claimed or not. Repos outside the workspace and
   bare repos are not checked.

## What it does NOT block

- Anything inside a **linked worktree**. This assumes agents are assigned
  different worktrees.
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
- An operator can disable the guard for a pi process with `PI_WORKTREE_GUARD=0`.
  Setting that variable inside a bash tool call does not change the current
  parent process. This is an operational switch, not a security boundary against
  an agent that can launch other processes or edit files.
- Claim I/O errors and exceptions in the outer tool-call handler fail open.
  The guard only inspects pi `bash` calls; arbitrary edits, other tools, external
  processes, and two sessions sharing one linked worktree are outside its coverage.
- `npm test` runs the parser and location tests in `tests/` with Node's
  built-in TypeScript support (Node 22.18+).
- Claims and check state live under `.git/` — nothing tracked by git, no
  merge noise, no repo pollution.

## Install

```bash
pi install git:github.com/Pfgoriaux/pi-worktree-guard
# Or this workspace's local checkout:
pi install /Users/pf/eden/tools/pi/extensions/pi-worktree-guard
```

Reload pi after installation. Local paths in settings resolve relative to the
settings file, not the workspace.

## Companion rules

Use distinct worktrees for concurrent sessions. Report uncommitted changes
honestly; committing or pushing still requires the user's authorization. This
guard does not require a commit before reporting work done.


## The pi extension family

Five packages, one workflow: plan, fan out, review, protect, verify.

| Package | Job |
|---|---|
| [pi-dispatch](https://github.com/Pfgoriaux/pi-dispatch) | parallel sub-agent fan-out, merge-back, Herdr arborescence |
| [pi-feature-swarm](https://github.com/Pfgoriaux/pi-feature-swarm) | multi-model feature discovery & planning, no code changes intended |
| [pi-pr-swarm](https://github.com/Pfgoriaux/pi-pr-swarm) | multi-model PR review, then aggregate & fix |
| [pi-worktree-guard](https://github.com/Pfgoriaux/pi-worktree-guard) | best-effort guard against conflicting Git operations in a shared main checkout |
| [pi-repo-check](https://github.com/Pfgoriaux/pi-repo-check) | repo hygiene gate: conventions, docs-in-pairs, baseline |
