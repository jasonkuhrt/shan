/**
 * shan skills install <source> [--skill <name>]... [--all] [--scope user]
 *
 * Import skills from a skills.sh source into shan's own library/outfit model.
 * The importer installs into the canonical Claude outfit first, then converts
 * the imported skills into shan-managed pluggable skills so history, moves,
 * and agent mirrors continue to work.
 */

import { spawn } from 'node:child_process'
import { lstat, rename } from 'node:fs/promises'
import * as path from 'node:path'
import { Console, Effect } from 'effect'
import * as Lib from '../../lib/skill-library.js'
import { skillsMove } from './move.js'
import { skillsOn } from './on.js'

export interface SkillsInstallOptions {
  readonly scope: Lib.Scope
  readonly all: boolean
  readonly skills: readonly string[]
  readonly runCli?: (
    args: readonly string[],
  ) => Effect.Effect<{ stdout: string; stderr: string }, unknown>
}

interface ImportedSkill {
  readonly canonicalName: string
}

const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const usageError = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(
      'Usage: shan skills install <source> [--skill <name>]... [--all] [--scope user]',
    )
    yield* Console.error(
      '  Example: shan skills install vercel-labs/agent-skills --skill typed-api-dx-review',
    )
    return yield* Effect.fail(new Error(message))
  })

const defaultRunCli = (args: readonly string[]) =>
  Effect.tryPromise(
    () =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(NPX_BIN, ['--yes', 'skills', ...args], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })

        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ stdout, stderr })
            return
          }

          const detail =
            stderr.trim() || stdout.trim() || `npx skills exited with code ${code ?? 'unknown'}`
          reject(new Error(detail))
        })
      }),
  )

const getImportedCoreSkills = (scope: Lib.Scope, beforeNames: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const outfit = yield* Lib.listOutfit(scope)
    return outfit
      .filter((entry) => entry.commitment === 'core')
      .map((entry) => entry.name)
      .filter((name) => !beforeNames.has(name))
      .sort()
  })

const normalizeImportedSkill = (scope: Lib.Scope, currentName: string) =>
  Effect.gen(function* () {
    const skillDir = path.join(Lib.outfitDir(scope), currentName)
    const frontmatter = yield* Lib.readFrontmatter(skillDir)
    const canonicalName = frontmatter?.name ?? currentName
    const normalizedEntryName = Lib.flattenName(Lib.colonToPath(canonicalName))

    if (normalizedEntryName !== currentName) {
      const normalizedPath = path.join(Lib.outfitDir(scope), normalizedEntryName)
      const occupied = yield* Effect.tryPromise(async () => {
        await lstat(normalizedPath)
        return true
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (occupied) {
        return yield* Effect.fail(
          new Error(`Imported skill path already exists: ${normalizedEntryName}`),
        )
      }

      yield* Effect.tryPromise(() => rename(skillDir, normalizedPath))
    }

    return { canonicalName } satisfies ImportedSkill
  })

export const skillsInstall = (source: string, options: SkillsInstallOptions) =>
  Effect.gen(function* () {
    if (!source) {
      return yield* usageError('Missing targets')
    }

    if (!options.all && options.skills.length === 0) {
      return yield* usageError('Missing targets')
    }

    const runCli = options.runCli ?? defaultRunCli
    const canonicalOutfit = Lib.outfitDir(options.scope)
    yield* Lib.ensureOutfitDir(canonicalOutfit)

    const beforeNames = new Set(
      (yield* Lib.listOutfit(options.scope))
        .filter((entry) => entry.commitment === 'core')
        .map((entry) => entry.name),
    )

    const cliArgs = ['add', source, '--agent', 'claude-code', '--copy']
    if (options.scope === 'user') {
      cliArgs.push('--global')
    }
    if (options.all) {
      cliArgs.push('--skill', '*')
    } else {
      for (const skill of options.skills) {
        cliArgs.push('--skill', skill)
      }
    }

    yield* Console.log(`Importing skills from ${source}`)
    const cliResult = yield* runCli(cliArgs)

    if (cliResult.stdout.trim()) {
      yield* Console.log(cliResult.stdout.trimEnd())
    }
    if (cliResult.stderr.trim()) {
      yield* Console.error(cliResult.stderr.trimEnd())
    }

    const importedNames = yield* getImportedCoreSkills(options.scope, beforeNames)
    if (importedNames.length === 0) {
      yield* Console.log('No new skills were imported.')
      return
    }

    const normalizedImports: ImportedSkill[] = []
    for (const importedName of importedNames) {
      normalizedImports.push(yield* normalizeImportedSkill(options.scope, importedName))
    }

    const canonicalNames = normalizedImports.map((skill) => skill.canonicalName)

    yield* Console.log('')
    yield* Console.log(
      `Converting ${canonicalNames.length} imported skill${canonicalNames.length === 1 ? '' : 's'} into shan-managed pluggable skills`,
    )
    yield* skillsMove('commitment', 'down', canonicalNames.join(','), {
      scope: options.scope,
      strict: false,
    })

    const topGroups = [
      ...new Set(
        canonicalNames.flatMap((name) => {
          const topGroup = name.includes(':') ? [name.split(':')[0] ?? ''] : []
          return topGroup.filter(Boolean)
        }),
      ),
    ]
    if (topGroups.length > 0) {
      yield* skillsOn(topGroups.join(','), { scope: options.scope, strict: false })
    }
  })
