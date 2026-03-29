/**
 * shan init
 *
 * Scaffold project-level agent rule files using the local system's agent
 * configuration as the naming reference. Existing files are preserved.
 */

import { Console, Effect } from 'effect'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { getRuntimeConfig } from '../lib/runtime-config.js'

const SYSTEM_CLAUDE_RULE_BASENAMES = ['CLAUDE.md', 'claude.md'] as const

const pathExists = (filePath: string) =>
  Effect.tryPromise(async () => {
    await lstat(filePath)
    return true
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))

export type ClaudeRuleBasename = (typeof SYSTEM_CLAUDE_RULE_BASENAMES)[number]

const resolveHomeDir = () => getRuntimeConfig().homeDir

export const detectSystemClaudeRuleBasename = (
  homeDir: string = resolveHomeDir(),
): Effect.Effect<ClaudeRuleBasename> =>
  Effect.gen(function* () {
    const claudeDir = path.join(homeDir, '.claude')
    const entries = yield* Effect.tryPromise(() => readdir(claudeDir)).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    )

    for (const basename of SYSTEM_CLAUDE_RULE_BASENAMES) {
      if (entries.includes(basename)) return basename
    }

    return 'CLAUDE.md'
  })

const toLocalOverlayBasename = (basename: ClaudeRuleBasename) =>
  basename.replace(/\.md$/u, '.local.md')

const renderAgentsFile = (claudeRuleBasename: ClaudeRuleBasename) =>
  `@.claude/${claudeRuleBasename}
@.claude/*.local.md
`

const renderClaudeRuleFile = (claudeRuleBasename: ClaudeRuleBasename) => `# Project Instructions

Add repo-specific agent rules here.

## Purpose

- Capture project architecture, workflows, and conventions that do not belong in the home-level agent config.
- Keep this file focused on shared project rules.
- Use \`.claude/*.local.md\` for personal, worktree-specific, or temporary overlays.

## Next Steps

- Document the canonical dev commands for this repo.
- Document branch and review workflow if it differs from the global defaults.
- Add focused rule files under \`.claude/rules/\` if this project grows beyond a single instruction file.

<!-- Scaffolded by \`shan init\` from the local ${claudeRuleBasename} convention. -->
`

const renderLocalOverlayFile = (claudeRuleBasename: ClaudeRuleBasename) => `# Local Overlay

Add worktree-local or personal instructions here when this project needs them.

- Keep shared project policy in \`.claude/${claudeRuleBasename}\`.
- Use this file for overlays that are specific to your current checkout or environment.
`

export const shanInit = () => shanInitWith()

export interface ShanInitOptions {
  readonly homeDir?: string
  readonly projectRoot?: string
}

export const shanInitWith = (options: ShanInitOptions = {}) =>
  Effect.gen(function* () {
    const projectRoot = options.projectRoot ?? getRuntimeConfig().projectRoot
    const claudeRuleBasename = yield* detectSystemClaudeRuleBasename(options.homeDir)
    const localOverlayBasename = toLocalOverlayBasename(claudeRuleBasename)

    const targets = [
      {
        label: 'AGENTS.md',
        filePath: path.join(projectRoot, 'AGENTS.md'),
        content: renderAgentsFile(claudeRuleBasename),
      },
      {
        label: `.claude/${claudeRuleBasename}`,
        filePath: path.join(projectRoot, '.claude', claudeRuleBasename),
        content: renderClaudeRuleFile(claudeRuleBasename),
      },
      {
        label: `.claude/${localOverlayBasename}`,
        filePath: path.join(projectRoot, '.claude', localOverlayBasename),
        content: renderLocalOverlayFile(claudeRuleBasename),
      },
    ] as const

    let createdCount = 0

    for (const target of targets) {
      if (yield* pathExists(target.filePath)) {
        yield* Console.log(`exists  ${target.label}`)
        continue
      }

      yield* Effect.tryPromise(() => mkdir(path.dirname(target.filePath), { recursive: true }))
      yield* Effect.tryPromise(() => writeFile(target.filePath, target.content))
      createdCount += 1
      yield* Console.log(`created ${target.label}`)
    }

    if (createdCount === 0) {
      yield* Console.log('shan init: nothing to do')
    }
  })
