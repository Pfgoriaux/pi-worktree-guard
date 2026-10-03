# pi-worktree-guard

A best-effort guard against one pi session stashing, switching, or discarding
another session's work in a shared main checkout. It supports separate worktrees;
it does not enforce exclusive ownership of every worktree. See [README.md](README.md).

## Constraints

- Implementation: `extensions/worktree-guard.ts`, loaded directly by pi. It
  intercepts `bash` tool calls through `tool_call`; it does not replace the shell
  or cover arbitrary file edits and external processes.
- Blocking is cross-session: the target main checkout must have another live
  claim. Single-session operations are unchanged.
- Linked worktrees are exempt in the current implementation. Two agents can
  still collide if they share one linked worktree; assign distinct worktrees.
- Claim bookkeeping and the outer tool-call handler fail open on exceptions.
  Recognized indirect Git mutations can be blocked, but this is not a general
  shell sandbox or a fail-closed filesystem boundary.
- Claim files stay under `.git/`. Keep routine read-only Git operations usable;
  the scanner conservatively blocks `checkout`, including path-restoration forms.
- No build step. `npm test` runs the parser and location tests in `tests/`.
  Parser and claim-lifecycle changes need deterministic regression tests; a
  prose guarantee is not a substitute for those checks.
- The location rule blocks `git worktree add` outside
  `<PI_WORKTREE_ROOT>/<repo path relative to its parent>/` for repos inside
  that parent. It runs before the claim checks and needs no rival session.
- Never interpret this guard as permission to commit, push, or switch another
  session's checkout. The user's authorization still controls those actions.
