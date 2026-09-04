# AGENTS.md

`pi-worktree-guard` enforces one branch = one worktree = one agent for
the pi coding agent. Born from a real incident: a second agent ran
`git stash` + `git checkout` under a first agent's feet and parked 23
uncommitted paths in the stash pile. This extension makes that
impossible without breaking single-session workflows.

## Essentials

- Single-file extension: `extensions/worktree-guard.ts` (pi loads it
  directly — no build step).
- Extends the pi `bash` tool in place — no new command surface.

## Non-obvious rules

- Blocking is **cross-session only**: a session may do anything to a
  checkout it owns; blocks fire only when another live pi session holds
  a claim on the same main checkout. Never block the claiming session's
  own ops, and never block read-only git commands — ever.
- Claim bookkeeping is advisory: any fs failure in claim I/O degrades to
  "no claim" (fail open on bookkeeping). The git-op decision itself is
  the only place that fails closed.
- Linked worktrees never claim and are never blocked — they can't
  collide by construction. Don't add protection there; it would be noise.
