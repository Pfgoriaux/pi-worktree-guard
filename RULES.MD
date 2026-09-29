# Working rules

- Prefer the smallest change that solves the actual problem. No speculative
  features, abstractions, or unrelated refactors. Preserve unrelated work.
- Keep files and components small, focused on one responsibility, and easy to
  read. When a file or feature grows long, split it cleanly along responsibility
  lines instead of letting it bloat. Enforce size limits in tooling, not by
  counting lines.
- Enforce mechanical rules with linting, types, tests, and CI, not prose.
  Use scripts for repeatable workflows; do not weaken checks to make them pass.
- Run relevant checks before declaring completion, and verify observable
  behavior before saying it works: run the code, hit the endpoint, exercise
  the fix. An unverified change is not done. Report failures and checks you
  could not run; never claim mocked tests verify live behavior.
- Keep AGENTS.md to purpose, non-obvious constraints, safety boundaries, and
  conditional documentation pointers. Do not repeat what code or config says.
- AGENTS.md is not a journal: no session summaries, test results or inventories,
  completed tasks, incident histories, or discovery logs. Durable, essential
  constraints and pointers to safe check entry points belong there.
- Documentation is sediment, not archaeology: every edit compresses into one
  durable layer that says what is true now and why. Docs must never become a
  changelog, roadmap, session log, or dig site of past fixes — history lives in
  Git, plans live where work is tracked, regressions live in the test suite.
  Before creating any .md, extend an existing doc or justify why code, config,
  or a commit message cannot hold it; merge overlapping docs, because
  contradicting documents are worse than none.
- Tests are code, not prose: encode regressions in the test suite and let CI
  report results; never write test reports or fix logs as .md files. Decisions
  become ADRs only when they pass the ADR bar; routine choices live in code
  comments, commit messages, or PR descriptions.
- Read relevant ADRs before changing architecture. Record consequential choices
  in docs/adr/ when making them: context, decision, alternatives, consequences.
  Supersede existing decisions explicitly; routine edits do not need an ADR.
- Update documentation when guidance becomes inaccurate. Remove obsolete
  guidance rather than accumulating amendments; keep detailed procedures in docs.
- Current server capacity must not constrain scope, performance targets, or scale.
  The owner upgrades CPU, RAM, storage, or server performance and adds servers
  whenever needed. Propose the required capacity rather than treating today's
  hardware as a fixed ceiling; retain safety limits and third-party quotas.
- Never commit or push without permission. Production writes, deployments,
  restarts, and infrastructure changes require explicit authorization.
- One agent per checkout: when multiple agents work in the same repo in
  parallel, each gets its own git worktree and branch. Never stash, switch,
  reset, or clean in a checkout another agent is using.
- Localhost does not mean test data. Verify isolated development/test targets;
  never trust an existing .env to be safe. Preserve production and access boundaries.
- Keep secrets in approved storage, never in tracked files, logs, or replies.
