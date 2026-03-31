#!/usr/bin/env bun
/**
 * shan - agent tooling CLI (named after Claude Shannon)
 *
 * Usage:
 *   shan init
 *   shan <namespace> <command> [args...]
 *
 * Namespaces:
 *   doctor        Health checks and static analysis
 *   transcript    Transcript manipulation commands
 *   task          Task list inspection commands
 *   skills | s    Skill library and outfit management
 */

import { Console, Effect } from 'effect'
import { doctor } from './doctor.js'
import { transcriptDump } from './transcript/dump.js'
import { transcriptAnalyze } from './transcript/analyze.js'
import { transcriptPrint } from './transcript/print.js'
import { taskDump } from './task/dump.js'
import { taskOpen } from './task/open.js'
import { shanInit } from './init.js'
import { skillsOn } from './skills/on.js'
import { skillsOff } from './skills/off.js'
import { skillsList } from './skills/list.js'
import { skillsHistory } from './skills/history.js'
import { skillsUndo } from './skills/undo.js'
import { skillsRedo } from './skills/redo.js'
import { skillsMigrate } from './skills/migrate.js'
import { skillsMove } from './skills/move.js'
import { skillsInstall } from './skills/install.js'
import { skillsInstallUser } from './skills/install-user.js'
import { skillsCreate } from './skills/create.js'
import type { MoveAxis, MoveDirection } from './skills/move.js'
import type { Scope } from '../lib/skill-library.js'
import * as Lib from '../lib/skill-library.js'

const USAGE = `
shan - agent tooling CLI

Usage:
  shan init
  shan <namespace> <command> [target] [options]

Namespaces:
  doctor        Health checks and static analysis
  transcript    Transcript manipulation commands
  task          Task list inspection commands
  skills | s    Skill library and outfit management

Commands:
  shan init                             Scaffold missing project agent rule files
  shan doctor [selector]                Run doctor checks across namespaces
  shan doctor skills                    Run skills/* checks
  shan doctor config                    Run config/* checks

  shan transcript print [target]        Print readable conversation log
  shan transcript dump [target]         Dump transcript as navigable Markdown
  shan transcript dump --raw [target]   Copy raw JSONL without transformation
  shan transcript analyze [target]      Visualize context consumption

  shan task dump [target]               Copy task JSON into project
  shan task dump --md [target]          Convert tasks to Markdown
  shan task open [target]               Open task list or file in editor

  shan skills | shan s                  Show outfit (default: list)
  shan skills on <targets>              Turn on skills/groups (comma-separated)
  shan skills off [targets]             Turn off skills/groups (no targets = reset all)
  shan skills move <axis> <dir> <tgt>   Migrate between scopes or commitments
  shan skills list                      Show effective outfit across all layers
  shan skills history                   Show operation log
  shan skills undo [N]                  Undo last N operations (default: 1)
  shan skills redo [N]                  Redo last N undone operations (default: 1)
  shan skills create <name>             Scaffold a new skill with SKILL.md template
  shan skills install <source>          Import skills from skills.sh into shan
  shan skills install-user              Install bundled shan skills at user scope

Options:
  --all                Show all sessions/task lists (default: current project only)
  --no-fix             Report doctor findings without applying fixes
  --show <layers>      Add detail layers to print: results,diffs,thinking,trace,all
  --scope user         Operate on user outfit (default: project)
  --global             Alias for --scope user
  --strict             Report no-ops as errors

Transcript target:
  - Session ID (or prefix): abc123, 9ba30f6f-...
  - File path: ./file.jsonl, /path/to/file.jsonl, ~/file.jsonl
  - Omit for interactive picker (requires TTY)

Task target:
  - List name or UUID prefix: test-schema, 21b0
  - List + task: test-schema@3, 21b0@1
  - Subject search: @Scaffold
  - Omit for interactive picker (requires TTY)
`.trim()

const SKILLS_USAGE = `
Available commands:
  on <targets>              Turn on skills/groups (comma-separated)
  off [targets]             Turn off skills/groups (no targets = reset all)
  move <axis> <dir> <tgt>   Migrate between scopes or commitments
  list                      Show effective outfit across all layers
  history                   Show operation log
  undo [N]                  Undo last N operations
  redo [N]                  Redo last N undone operations
  create <name>             Scaffold a new skill with SKILL.md template
  install <source>          Import skills from skills.sh into shan
  migrate [--execute]       Migrate from flat inventory to hierarchical library
  install-user              Install bundled shan skills at user scope

Options:
  --scope user | --global   Operate on user outfit (default: project)
  --strict                  Report no-ops as errors
  --skill <name>            Select specific skills for skills install
`.trim()

/**
 * Parse args, extracting known flags and returning the remaining positional args.
 */
export interface ParsedFlags {
  raw: boolean
  all: boolean
  md: boolean
  execute: boolean
  strict: boolean
  global: boolean
  noFix: boolean
  show: string[]
  skill: string[]
  scope: string
}

export const parseArgs = (args: string[]) => {
  const flags: ParsedFlags = {
    raw: false,
    all: false,
    md: false,
    execute: false,
    strict: false,
    global: false,
    noFix: false,
    show: [],
    skill: [],
    scope: '',
  }
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--raw') flags.raw = true
    else if (arg === '--all') flags.all = true
    else if (arg === '--md') flags.md = true
    else if (arg === '--execute') flags.execute = true
    else if (arg === '--strict') flags.strict = true
    else if (arg === '--global') flags.global = true
    else if (arg === '--no-fix') flags.noFix = true
    else if (arg.startsWith('--skill=')) flags.skill.push(arg.slice(8))
    else if (arg === '--skill' && i + 1 < args.length) {
      flags.skill.push(args[++i] ?? '')
    } else if (arg === '--scope' && i + 1 < args.length) {
      flags.scope = args[++i] ?? ''
    } else if (arg.startsWith('--scope=')) {
      flags.scope = arg.slice(8)
    } else if (arg.startsWith('--show=')) flags.show.push(arg.slice(7))
    else if (arg === '--show' && i + 1 < args.length) {
      flags.show.push(args[++i] ?? '')
    } else positional.push(arg)
  }

  return { flags, positional }
}

export const resolveScope = (flags: ParsedFlags): Scope =>
  flags.global ? 'user' : flags.scope === 'user' ? 'user' : 'project'

const resolveAllTargetsInScope = (targets: readonly string[], scope: Scope) =>
  Effect.gen(function* () {
    for (const target of targets) {
      const resolved = yield* Lib.resolveTarget(target, scope)
      if (!resolved) return false
    }
    return true
  })

export const resolveSkillsOnScope = (flags: ParsedFlags, targetInput: string) =>
  Effect.gen(function* () {
    if (flags.global || flags.scope === 'user') return 'user' as const
    if (flags.scope === 'project') return 'project' as const

    const targets = Lib.parseTargets(targetInput)
    if (targets.length === 0) return 'project' as const

    const projectLibraryExists = yield* Lib.libraryExists('project')
    if (!projectLibraryExists) {
      const userLibraryExists = yield* Lib.libraryExists('user')
      return userLibraryExists ? ('user' as const) : ('project' as const)
    }

    if (yield* resolveAllTargetsInScope(targets, 'project')) return 'project' as const
    if (yield* resolveAllTargetsInScope(targets, 'user')) return 'user' as const

    return 'project' as const
  })

const historyCommands = new Set(['undo', 'redo', 'history'])

/**
 * Unified scope resolver for all skills subcommands.
 *
 * - Explicit --scope / --global flags always win.
 * - Target-based commands (on, off, move, etc.) infer scope from where the target lives.
 * - History commands (undo, redo, history) with no explicit scope check which scope
 *   has active history entries and prefer that. Falls back to project if both or neither have history.
 */
export const resolveSkillsScope = (flags: ParsedFlags, command: string, targetInput: string) =>
  Effect.gen(function* () {
    // Explicit flags always win
    if (flags.global || flags.scope === 'user') return 'user' as const
    if (flags.scope === 'project') return 'project' as const

    // History commands: infer from which scope has the most recent active entry
    if (historyCommands.has(command)) {
      const state = yield* Lib.loadState()
      const projectHistory = Lib.getProjectHistory(state, 'project')
      const userHistory = Lib.getProjectHistory(state, 'user')
      const projectActiveCount = projectHistory.entries.length - projectHistory.undoneCount
      const userActiveCount = userHistory.entries.length - userHistory.undoneCount

      if (userActiveCount > 0 && projectActiveCount === 0) return 'user' as const
      if (projectActiveCount > 0 && userActiveCount === 0) return 'project' as const

      // Both have active history: prefer the scope with the most recent timestamp
      if (userActiveCount > 0 && projectActiveCount > 0) {
        const lastUserEntry = userHistory.entries[userActiveCount - 1]
        const lastProjectEntry = projectHistory.entries[projectActiveCount - 1]
        if (lastUserEntry && lastProjectEntry) {
          return lastUserEntry.timestamp > lastProjectEntry.timestamp
            ? ('user' as const)
            : ('project' as const)
        }
      }

      return 'project' as const
    }

    // Target-based commands: infer from where the target lives
    return yield* resolveSkillsOnScope(flags, targetInput)
  })

const removedCommand = (removed: string, replacement: string, detail: string) =>
  Effect.gen(function* () {
    yield* Console.error(`\`${removed}\` was removed. Use \`${replacement}\` instead.`)
    yield* Console.log(`\n${detail}`)
    return yield* Effect.fail(new Error('Unknown command'))
  })

export const program = Effect.gen(function* () {
  const [namespace, command, ...args] = process.argv.slice(2)

  if (!namespace) {
    yield* Console.log(USAGE)
    return
  }

  if (namespace === 'init') {
    yield* shanInit()
  } else if (namespace === 'doctor') {
    const { flags, positional } = parseArgs(command ? [command, ...args] : args)
    yield* doctor({
      selector: positional[0] ?? '',
      noFix: flags.noFix,
      scope: resolveScope(flags),
    })
  } else if (namespace === 'transcript') {
    const { flags, positional } = parseArgs(args)

    if (command === 'print') {
      yield* transcriptPrint(positional[0], { show: flags.show, all: flags.all })
    } else if (command === 'dump') {
      yield* transcriptDump(positional[0], { raw: flags.raw, all: flags.all })
    } else if (command === 'analyze') {
      yield* transcriptAnalyze(positional[0], { all: flags.all })
    } else {
      yield* Console.error(`Unknown transcript command: ${command}`)
      yield* Console.log(
        '\nAvailable commands:\n  print <session-id>      Print readable conversation log\n  dump <session-id>       Dump transcript as navigable Markdown\n  analyze <session-id>    Visualize context consumption',
      )
      return yield* Effect.fail(new Error('Unknown command'))
    }
  } else if (namespace === 'lint') {
    return yield* removedCommand(
      'shan lint',
      'shan doctor config',
      'Run `shan doctor config` for Claude settings checks, or `shan doctor config/<rule>` to target one config rule.',
    )
  } else if (namespace === 'task') {
    const { flags, positional } = parseArgs(args)

    if (command === 'dump') {
      yield* taskDump(positional[0], { md: flags.md, all: flags.all })
    } else if (command === 'open') {
      yield* taskOpen(positional[0], { all: flags.all })
    } else {
      yield* Console.error(`Unknown task command: ${command}`)
      yield* Console.log(
        '\nAvailable commands:\n  dump [target]    Copy task JSON into project\n  open [target]    Open task list or file in editor',
      )
      return yield* Effect.fail(new Error('Unknown command'))
    }
  } else if (namespace === 'skills' || namespace === 's') {
    const { flags, positional } = parseArgs(args)
    const targetInput = command === 'move' ? (positional[2] ?? '') : (positional[0] ?? '')
    const scope = yield* resolveSkillsScope(flags, command ?? '', targetInput)

    if (command === 'on') {
      yield* skillsOn(positional[0] ?? '', { scope, strict: flags.strict })
    } else if (command === 'off') {
      yield* skillsOff(positional[0] ?? '', { scope, strict: flags.strict })
    } else if (command === 'move') {
      const axisInput = positional[0]
      const directionInput = positional[1]
      const moveTargets = positional[2] ?? ''
      const isAxis = (s: string): s is MoveAxis => s === 'scope' || s === 'commitment'
      const isDirection = (s: string): s is MoveDirection => s === 'up' || s === 'down'
      if (!axisInput || !directionInput || !isAxis(axisInput) || !isDirection(directionInput)) {
        yield* Console.error('Usage: shan skills move <scope|commitment> <up|down> <targets>')
        return yield* Effect.fail(new Error('Missing targets'))
      }
      yield* skillsMove(axisInput, directionInput, moveTargets, { scope, strict: flags.strict })
    } else if (command === 'list' || !command) {
      yield* skillsList()
    } else if (command === 'history') {
      yield* skillsHistory(scope)
    } else if (command === 'undo') {
      yield* skillsUndo(Number(positional[0]) || 1, scope)
    } else if (command === 'redo') {
      yield* skillsRedo(Number(positional[0]) || 1, scope)
    } else if (command === 'doctor') {
      return yield* removedCommand(
        'shan skills doctor',
        'shan doctor skills',
        'Run `shan doctor skills` for the full skills doctor pass, or `shan doctor skills/<rule>` for one namespaced skill rule.',
      )
    } else if (command === 'migrate') {
      yield* skillsMigrate({ execute: flags.execute })
    } else if (command === 'create') {
      yield* skillsCreate(positional[0] ?? '', { scope })
    } else if (command === 'install') {
      yield* skillsInstall(positional[0] ?? '', {
        scope,
        all: flags.all,
        skills: flags.skill,
      })
    } else if (command === 'install-user') {
      yield* skillsInstallUser()
    } else {
      yield* Console.error(`Unknown skills command: ${command}`)
      yield* Console.log('\n' + SKILLS_USAGE)
      return yield* Effect.fail(new Error('Unknown command'))
    }
  } else {
    yield* Console.error(`Unknown namespace: ${namespace}`)
    yield* Console.log(USAGE)
    return yield* Effect.fail(new Error('Unknown namespace'))
  }
})

export const QUIET_ERRORS = new Set([
  'Unknown command',
  'Unknown namespace',
  'Missing targets',
  'Library not found',
  'Skill already exists',
  'Some targets failed',
  'Lint errors found',
  'Doctor errors found',
])

export const run = async () => {
  try {
    await Effect.runPromise(program)
  } catch (err: unknown) {
    if (err instanceof Error && !QUIET_ERRORS.has(err.message)) {
      console.error(err)
    }
    process.exit(1)
  }
}

if (import.meta.main) {
  void run()
}
