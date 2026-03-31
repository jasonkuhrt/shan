# Contributing to shan

## Getting Started

`shan` is a Bun + TypeScript + Effect CLI. Start from the repo root:

```sh
bun install
just hooks-install
```

`just` is a convenience layer over the repo's checked-in package scripts. Use either style:

```sh
just test
just check
just run skills list
```

```sh
bun run test
bun run check
bun run shan -- skills list
```

Useful day-to-day commands:

- `bun run fix` formats and applies safe lint fixes
- `bun run check` runs the full quality gate
- `bun run docs:dev` starts the docs site locally
- `bun run docs:build` verifies the docs site builds
- `bun run test:coverage` writes the raw coverage report

For type checks, use `bun run check:types`. This repo routes type checking through its configured toolchain; do not run `tsc` directly.

The repo keeps hook behavior in [`.git-hooks/pre-commit.d/`](./.git-hooks/pre-commit.d/), while `just hooks-install` installs those hooks into your local Git config.

## Codebase Map

- [`src/bin/`](./src/bin/) contains CLI entrypoints, argument parsing, and user-facing reporting.
- [`src/bin/skills/`](./src/bin/skills/) holds the skill mutation commands: `on`, `off`, `move`, `list`, `install`, `undo`, `redo`, and related helpers.
- [`src/bin/transcript/`](./src/bin/transcript/) and [`src/bin/task/`](./src/bin/task/) implement the read-only transcript and task namespaces.
- [`src/lib/`](./src/lib/) contains the core domain logic: library/outfit management, dependency graph rules, doctor aspects, schema parsing, transcript analysis, and rendering helpers.
- [`src/bundled-skills/`](./src/bundled-skills/) is the bundled skill corpus that `shan` can install for users.
- [`src/exports/`](./src/exports/) defines the public library surface for external consumers.
- [`content/docs/`](./content/docs/) is the public documentation site, including concepts, guides, and reference pages.
- [`scripts/`](./scripts/) contains repo automation such as the test runner, coverage checks, and packaging helpers.

## Boundaries

- Keep CLI orchestration in [`src/bin/`](./src/bin/). Argument parsing, command wiring, and terminal presentation belong there.
- Keep reusable rules and invariants in [`src/lib/`](./src/lib/). Dependency legality, frontmatter parsing, graph validity, filesystem modeling, and history semantics should not be reimplemented in command files.
- Treat [`src/bundled-skills/`](./src/bundled-skills/) as shipped product content, not scratch fixtures. Changes there affect user-facing behavior and docs.
- Treat [`content/docs/`](./content/docs/) as part of the product contract. If a command, invariant, or workflow changes, update the docs in the same branch.
- Preserve the library/outfit split. The library stores available pluggable skills; the outfit is the active view Claude Code reads.
- Preserve the graph invariant. Active skills must remain dependency-complete after every command.
- Use Effect service boundaries for runtime dependencies. If code needs filesystem, time, randomness, environment, or other runtime effects, model that through the established Effect patterns instead of ad hoc globals.

## Extension Points

- Add a new CLI command by creating a module under [`src/bin/`](./src/bin/) and wiring it through [`src/bin/shan.ts`](./src/bin/shan.ts).
- Extend skill metadata in [`src/lib/skill-frontmatter.ts`](./src/lib/skill-frontmatter.ts) and propagate the semantics through [`src/lib/skill-graph.ts`](./src/lib/skill-graph.ts) and the relevant command flows.
- Add a new graph or filesystem health check in [`src/lib/doctor-aspects.ts`](./src/lib/doctor-aspects.ts), including auto-fix behavior only when the repair is deterministic and safe.
- Add or update bundled skills under [`src/bundled-skills/`](./src/bundled-skills/) when the CLI should ship a new built-in workflow.
- Add user-facing docs under [`content/docs/`](./content/docs/) and update local navigation metadata when the public mental model changes.
- Extend exported library APIs in [`src/exports/`](./src/exports/) when functionality should be consumable outside the CLI.

## Key Decisions

- `shan` is Effect-first. Use Effect control flow, schemas, and service boundaries instead of mixing in ad hoc imperative error handling patterns.
- The Claude outfit is canonical. Other agent roots such as Codex are mirrors that reconcile from the Claude-managed state.
- Skills are modeled as a dependency-aware graph, not just a directory listing. Namespaces, shadowing, dependencies, dependents, and scope rules all matter.
- The system is provenance-free. `shan` tracks the active state and history snapshots, not why a skill originally became active.
- History and repair are first-class features. `undo`, `redo`, `doctor`, and mirror reconciliation are part of the design, not afterthoughts.
- Docs and tests ship with behavior. If you change the skill graph, command semantics, or state machine, update both the tests and the public docs in the same branch.
- The checked-in package scripts are the source of truth for automation. `just` wraps them for convenience, but contributors should keep the underlying Bun workflows healthy.

## Common Tasks

Add or change CLI behavior:

1. Implement the behavior in the right command module under [`src/bin/`](./src/bin/).
2. Move shared rules into [`src/lib/`](./src/lib/) instead of duplicating them in the command.
3. Update help text, README references, and docs pages that describe the behavior.
4. Add or update tests close to the changed feature.

Add or change skill graph semantics:

1. Update frontmatter parsing in [`src/lib/skill-frontmatter.ts`](./src/lib/skill-frontmatter.ts) if the declaration surface changes.
2. Update graph resolution and validation in [`src/lib/skill-graph.ts`](./src/lib/skill-graph.ts).
3. Update doctor coverage in [`src/lib/doctor-aspects.ts`](./src/lib/doctor-aspects.ts).
4. Update bundled skill examples and docs if the user-facing model changed.

Work on docs:

1. Edit the relevant pages in [`content/docs/`](./content/docs/).
2. Run `bun run docs:build` before closing the task.
3. If the docs describe command output or glossary terms, keep them aligned with the CLI help and README.

Before you finish a branch:

1. Run `bun run fix` if you changed source or docs that need formatting/lint fixes.
2. Run `bun run check` for the full repo gate.
3. Run targeted tests while iterating, but do not skip the full validation pass before calling the work done.
