# shan

[![trunk](https://github.com/jasonkuhrt/shan/actions/workflows/trunk.yaml/badge.svg)](https://github.com/jasonkuhrt/shan/actions/workflows/trunk.yaml)

Claude Code tooling CLI for three jobs:

- transcript inspection and export
- task list discovery and opening
- skill library and outfit management

The repo is now the product. Dotfiles can shell out to a globally installed `shan`, but the source of truth lives here.

## Clone Repo Workflow

```sh
git clone git@github.com:jasonkuhrt/shan.git
cd shan
just install
just hooks-install
```

Optional global registration for `bun x @jasonkuhrt/shan`:

```sh
just install-global
```

If you do not want the global registration, run it from the repo:

```sh
bun run shan -- skills list
```

## What Shan Manages

The CLI reads and writes a few stable locations:

- `~/.claude/shan/config.json`
- `~/.claude/shan/state.json`
- `~/.claude/skills-library/`
- `~/.claude/skills/`
- `.claude/skills-library/`
- `.claude/skills/`

Transcript and task commands also read Claude Code session/task files from the current machine and project.

## CLI

```text
shan transcript print [target]
shan transcript dump [target]
shan transcript dump --raw [target]
shan transcript analyze [target]

shan task dump [target]
shan task dump --md [target]
shan task open [target]

shan skills
shan skills on <targets>
shan skills off [targets]
shan skills move <axis> <direction> <targets>
shan skills list
shan skills history
shan skills undo [N]
shan skills redo [N]
shan skills doctor [--no-fix]
shan skills migrate [--execute]
```

Common examples:

```sh
shan transcript print
shan transcript dump dc8ffe42
shan task open
shan skills on playwright,linear
shan skills move scope up playwright
shan skills doctor
```

## Development

Primary workflows go through the root `justfile`:

```sh
just install
just install-global
just run skills list
just test
just check
```

Direct commands, if needed:

```sh
bun run shan -- transcript analyze
bun run check
```

Quality gates:

- `just pre-commit` runs format, lint, and type checks
- `just pre-push` runs the full `bun run check` gate

## Docs

Design notes that moved over with the extraction:

- `docs/transcript-dump-spec.md`
- `docs/transcript-analyze-plan.md`
- `docs/skills-move-design.md`
