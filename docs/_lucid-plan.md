# Lucid Generation Plan

## Archetype: CLI tool
## Voice: Technical, concise, second person "you", present tense. Direct and functional. No exclamation points. No emoji.
## One-liner: Dump Claude Code transcripts, open task files, and toggle skill outfits from the terminal.

## Content Plan
- [x] Phase 1: Autosearch
- [x] Phase 2.1: One-liner
- [x] Phase 2.2: How-to guides (3 guides)
- [x] Phase 2.3: Reference docs (CLI reference)
- [x] Phase 2.4: Conceptual overview
- [x] Phase 2.5: Quickstart (getting-started.mdx)
- [x] Phase 2.6: README
- [x] Phase 2.7: Optional content (glossary)
- [x] Phase 2.8: Landing page (index.mdx)
- [x] Phase 3: Verify + Review
- [x] Phase 4: Output (content/docs/*.mdx + Fumadocs site)

## Findings

### Project Identity
- **Name**: shan (named after Claude Shannon)
- **Package**: @jasonkuhrt/shan
- **License**: MIT
- **Runtime**: bun + TypeScript (tsgo for builds)
- **Framework**: Effect (Schema, gen, Console)
- **Linting**: oxlint + oxfmt
- **CLI structure**: hand-rolled argument parser in src/bin/shan.ts (no argc, no commander)

### Three Namespaces
1. **transcript** — inspect/export Claude Code session transcripts
   - `print` — readable conversation log with optional detail layers (results, diffs, thinking, trace)
   - `dump` — JSONL → navigable Markdown with columnar headings for editor outlines
   - `dump --raw` — copy raw JSONL
   - `analyze` — terminal visualization: stacked charts (time + tokens), dimension tracks, top consumers
2. **task** — inspect Claude Code task files
   - `dump` — copy task JSON into project, optionally as Markdown
   - `open` — open task list/file in $EDITOR
3. **skills** — full lifecycle management of Claude Code skill outfits
   - `on/off` — toggle skills by name or group
   - `move` — migrate between scopes (user↔project) and commitments (pluggable↔core)
   - `list` — show effective outfit with token costs
   - `history` — operation log
   - `undo/redo` — reversible operations with snapshot restore
   - `doctor` — 13-aspect health checks with auto-fix
   - `install-user` — install bundled shan skills at user scope
   - `migrate` — run data migrations

### Domain Vocabulary
- **outfit**: the set of active skills Claude Code sees (symlinks in `~/.claude/skills/` or `.claude/skills/`)
- **library**: all available pluggable skills (`~/.claude/skills-library/` or `.claude/skills-library/`)
- **core**: real directory in outfit — shan never touches it
- **pluggable**: symlink managed by shan, can be toggled on/off
- **scope**: user (global, `~/.claude/`) or project (default, `.claude/`)
- **commitment**: core (ejected, real files) or pluggable (symlinked from library)
- **colon-syntax**: naming convention for skills (e.g. `ts:tooling`, `flo:next`)
- **group target**: a directory with children — targeting it includes all descendant leaves
- **router**: generated `.claude/skills/<group>/SKILL.md` that routes to sub-skills

### Public Library Exports
- `@jasonkuhrt/shan` → task-schema + transcript-schema (Effect Schema definitions)
- `@jasonkuhrt/shan/transcript-schema` → transcript-schema only

### Bundled Skills
Ships 5 bundled Claude Code skills:
- `shan` — top-level router for all shan commands
- `skills` — router for skill management sub-skills
- `skills:change` — mutations (on/off/move/undo/redo)
- `skills:doctor` — health checks
- `skills:list` — read-only views

### Target Resolution
- Session targets: UUID/prefix, file path, or interactive picker (TTY)
- Task targets: list name, UUID prefix, list@N, @subject-search, or picker
- Skill targets: comma-separated colon-syntax names, supports groups

### Key Files
- `src/bin/shan.ts` — CLI entry point
- `src/lib/skill-library.ts` — core skill management logic (~60+ exports)
- `src/lib/transcript-schema.ts` — Effect Schema for transcript entries
- `src/lib/transcript-analyzer.ts` — analysis/visualization logic
- `src/lib/session-resolver.ts` — session ID → file path resolution
- `src/lib/task-schema.ts` — Effect Schema for task entries
- `src/lib/transcript-io.ts` — transcript file I/O
- `src/lib/transcript-parser.ts` — JSONL parsing
- `src/lib/transcript-turns.ts` — turn extraction for print command
- `src/lib/viz/` — chart, dimension track, and legend rendering

### Managed Locations
- `~/.claude/shan/config.json` — shan config
- `~/.claude/shan/state.json` — shan state (current installs, history)
- `~/.claude/skills-library/` — user-level library
- `~/.claude/skills/` — user-level outfit
- `.claude/skills-library/` — project-level library
- `.claude/skills/` — project-level outfit

## Backlog
- [ ] Homepage (`/`) returns 404 — needs an `app/page.tsx` that redirects to `/docs` or shows a landing page

## Exemplars
None found in sibling projects.

## Quality Scores (Mechanical Verification)
- Banned words found: 0
- Banned phrases found: 0
- Internal links valid: 12/12
- CLI commands verified against --help: all 15 commands confirmed
- Referenced symbols verified: analyzeTranscript, TranscriptEntry, AssistantMessage, Usage, resolveSessionPath, findSessionFile, extractSessionId — all found in source
- Config fields verified: historyLimit, defaultScope, doctor.disabled — all found in src/lib/skill-library.ts
- Cross-context review: completed — 4 HIGH (3 in pre-existing docs, 1 fixed), 4 MEDIUM (2 in pre-existing docs, 2 fixed), 3 LOW (1 fixed, 1 already addressed, 1 acceptable)
