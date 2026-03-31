# shan

[![trunk](https://github.com/jasonkuhrt/shan/actions/workflows/trunk.yaml/badge.svg)](https://github.com/jasonkuhrt/shan/actions/workflows/trunk.yaml)

Transcript tooling, task helpers, and a skill manager for Claude Code with Codex mirror support.

Named after Claude Shannon.

## Install

```sh
git clone git@github.com:jasonkuhrt/shan.git
cd shan
just install
```

Optional global registration (enables `bun x @jasonkuhrt/shan` from any directory):

```sh
just install-global
```

Install shan's bundled Claude Code skills (enables `/shan` inside Claude Code sessions):

```sh
just install-skills-user
```

## Common workflows

```sh
shan skills list
shan doctor skills
shan doctor config
shan s list
shan skills install vercel-labs/agent-skills --skill typed-api-dx-review
```

- `skills list` shows the effective outfit, budget usage, and any configured agent mirrors.
- `skills install` imports external `skills.sh` skills into shan's own library/outfit model.
- `doctor skills` audits and repairs skill drift, including missing or messy Codex mirrors.
- `doctor config` checks Claude settings for path hazards such as relative hook commands.

## Commands

### Init

```sh
shan init                                      # scaffold missing AGENTS/.claude rule files
```

### Transcripts

```sh
shan transcript print [target]                 # readable conversation log
shan transcript print --show diffs,results     # with edit diffs and tool results
shan transcript dump [target]                  # navigable Markdown with columnar headings
shan transcript dump --raw [target]            # copy raw JSONL
shan transcript analyze [target]               # terminal visualization of context consumption
```

### Tasks

```sh
shan task dump [target]                        # copy task JSON into project
shan task dump --md [target]                   # convert to Markdown
shan task open [target]                        # open in $EDITOR
```

### Skills

```sh
shan skills                                    # show outfit (default: list)
shan s                                         # alias for skills
shan skills on playwright,linear               # turn on skills
shan skills off ts                             # turn off a group
shan skills off                                # reset: off all pluggable
shan skills move scope up playwright           # project → user library
shan skills move commitment down playwright    # core → pluggable
shan skills history                            # operation log
shan skills undo                               # undo last operation
shan skills redo                               # redo last undone
shan skills install vercel-labs/agent-skills --skill typed-api-dx-review
shan skills install-user                       # install bundled shan skills
```

### Doctor

```sh
shan doctor                                    # run all doctor checks
shan doctor skills                             # run skill health checks
shan doctor skills --no-fix                    # report-only skill checks
shan doctor config                             # run Claude settings checks
shan doctor config/no-relative-hook-path       # target one config rule
```

### Targeting

Transcript targets: session ID prefix, full UUID, file path, or omit for interactive picker.

Task targets: list name, UUID prefix, `list@N`, `@subject-search`, or omit for picker.

Skill targets: comma-separated colon-syntax names (e.g. `ts:tooling,playwright`). Group names include all descendant leaves.

## Skill model

**Outfit** — the active skills an agent sees. For Claude, that is `~/.claude/skills/` or `.claude/skills/`. Outfits contain symlinks (pluggable) and real directories (core).

**Library** — all available pluggable skills. For Claude, that is `~/.claude/skills-library/` or `.claude/skills-library/`. Turning a skill on creates an outfit symlink back to the library.

**Scope** — `user` (global, `~/.claude/`) or `project` (repo-local, `.claude/`). The default scope is `project`.

**Commitment** — `core` means a real directory in the outfit that shan leaves alone. `pluggable` means a symlink managed by shan.

Every mutation records a snapshot for `undo`/`redo`. `doctor` runs 14 diagnostic aspects with auto-fix by default.

## Agent mirrors

Shan keeps Claude as the canonical agent for now. Other enabled agents mirror the Claude outfit as whole-directory symlinks instead of maintaining separate per-skill state.

Default config:

```json
{
  "version": 1,
  "skills": {
    "agents": "auto"
  }
}
```

Put that in `~/.config/shan/config.json`.

`"auto"` probes `claude` and `codex` on `PATH`, then caches the detected set in `~/.local/shan/cache.json` for 24 hours so shan does not re-probe on every command.

Current mirror contract:

- Claude is canonical at both scopes: `~/.claude/skills/` and `.claude/skills/`.
- If `codex` is enabled, shan manages `~/.codex/skills/` and `.codex/skills/` as mirrors of the matching Claude outfit directories.
- Equivalent symlink paths are accepted as healthy if they resolve to the same canonical directory.
- If shan finds a real Codex skills directory, it migrates non-conflicting entries into Claude and then restores the symlink shape.
- If both agents define the same skill name differently, shan stops and surfaces a conflict instead of guessing.

Pin the enabled set explicitly:

```json
{
  "version": 1,
  "skills": {
    "agents": ["claude", "codex"]
  }
}
```

If agent availability changes and you want to force a fresh `"auto"` probe immediately, remove `~/.local/shan/cache.json` or pin `skills.agents` explicitly.

Import `skills.sh` skills into shan's own library/outfit model:

```sh
shan skills install vercel-labs/agent-skills --skill typed-api-dx-review
shan skills install vercel-labs/agent-skills --all --scope user
```

The importer shells out to `skills.sh`, installs into the canonical Claude outfit first, then converts the imported skills into shan-managed pluggable entries so `history`, `move`, `doctor`, and agent mirrors all continue to work.

## Managed locations

| Path                         | Purpose                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `~/.config/shan/config.json` | Configuration                                                                 |
| `~/.local/shan/cache.json`   | Cached `skills.agents: "auto"` agent detection                                |
| `~/.claude/shan/state.json`  | Current installs, operation history                                           |
| `~/.claude/skills-library/`  | User skill library                                                            |
| `~/.claude/skills/`          | Canonical user outfit                                                         |
| `~/.codex/skills/`           | User mirror symlink to the canonical Claude outfit when `codex` is enabled    |
| `.claude/skills-library/`    | Project skill library                                                         |
| `.claude/skills/`            | Canonical project outfit                                                      |
| `.codex/skills/`             | Project mirror symlink to the canonical Claude outfit when `codex` is enabled |

## Development

```sh
just install          # bun install
just hooks-install    # one-time local git hook setup
just test             # bun test
just check            # format + lint + types + test + coverage + package + exports + CI
just coverage         # enforce 95% overall lines/functions coverage
just run skills list  # run shan from repo
```

This repo tracks its pre-commit behavior in `.git-hooks/pre-commit.d/`, so hook intent stays in the repo while installation stays local.

Raw coverage table:

```sh
bun run test:coverage
```

## Docs

Run the docs site locally with `bun run docs:dev`, then open `http://localhost:3000/docs`.

- [Getting started](content/docs/getting-started.mdx)
- [Conceptual overview](content/docs/concepts/overview.mdx)
- [CLI reference](content/docs/reference/cli.mdx)
- [Manage skill outfits](content/docs/guides/manage-skill-outfits.mdx)
- [Inspect transcripts](content/docs/guides/inspect-transcripts.mdx)
- [Work with tasks](content/docs/guides/work-with-tasks.mdx)

## License

MIT
