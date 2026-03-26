# shan

[![trunk](https://github.com/jasonkuhrt/shan/actions/workflows/trunk.yaml/badge.svg)](https://github.com/jasonkuhrt/shan/actions/workflows/trunk.yaml)

Dump Claude Code transcripts, open task files, import skills from `skills.sh`, and mirror active outfits to other agents.

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

## Commands

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
shan skills on playwright,linear               # turn on skills
shan skills off ts                             # turn off a group
shan skills off                                # reset: off all pluggable
shan skills move scope up playwright           # project → user library
shan skills move commitment down playwright    # core → pluggable
shan skills history                            # operation log
shan skills undo                               # undo last operation
shan skills redo                               # redo last undone
shan skills doctor                             # 13-aspect health checks + auto-fix
shan skills install vercel-labs/agent-skills --skill typed-api-dx-review
shan skills install-user                       # install bundled shan skills
```

### Targeting

Transcript targets: session ID prefix, full UUID, file path, or omit for interactive picker.

Task targets: list name, UUID prefix, `list@N`, `@subject-search`, or omit for picker.

Skill targets: comma-separated colon-syntax names (e.g. `ts:tooling,playwright`). Group names include all descendant leaves.

## Key concepts

**Outfit** — the set of active skills Claude Code sees (`~/.claude/skills/` or `.claude/skills/`). Contains symlinks (pluggable) and real directories (core).

**Library** — all available pluggable skills (`~/.claude/skills-library/` or `.claude/skills-library/`). Toggling a skill on creates a symlink from outfit to library; off removes it.

**Scope** — `user` (global, `~/.claude/`) or `project` (repo-local, `.claude/`). Default is project.

**Commitment** — `core` (real directory, shan never touches) or `pluggable` (symlink managed by shan).

**Agent config** — `~/.config/shan/config.json` controls which agent views shan should keep enabled. Claude remains the canonical backing store; non-Claude agents are exact generated mirrors.

Every mutation records a snapshot for `undo`/`redo`. `doctor` runs 13 diagnostic aspects with auto-fix.

Default config:

```json
{
  "version": 1,
  "skills": {
    "agents": "auto"
  }
}
```

`"auto"` probes `claude` and `codex` on `PATH`, then caches the installed set in `~/.local/shan/cache.json` for 24 hours.

Pin the enabled set explicitly:

```json
{
  "version": 1,
  "skills": {
    "agents": ["claude", "codex"]
  }
}
```

Import `skills.sh` skills into shan's own library/outfit model:

```sh
shan skills install vercel-labs/agent-skills --skill typed-api-dx-review
shan skills install vercel-labs/agent-skills --all --scope user
```

## Managed locations

| Path                         | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `~/.config/shan/config.json` | Configuration                                              |
| `~/.local/shan/cache.json`   | Cached `skills.agents: "auto"` agent detection             |
| `~/.claude/shan/state.json`  | Current installs, operation history                        |
| `~/.claude/skills-library/`  | User skill library                                         |
| `~/.claude/skills/`          | Canonical user outfit                                      |
| `~/.codex/skills/`           | User mirror outfit when resolved agents include `codex`    |
| `.claude/skills-library/`    | Project skill library                                      |
| `.claude/skills/`            | Canonical project outfit                                   |
| `.codex/skills/`             | Project mirror outfit when resolved agents include `codex` |

## Development

```sh
just install          # bun install
just test             # bun test
just check            # format + lint + types + test + coverage + package + exports + CI
just coverage         # enforce 95% overall lines/functions coverage
just run skills list  # run shan from repo
```

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
