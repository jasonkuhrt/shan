/**
 * shan skills create <name> [--scope user|project]
 *
 * Scaffold a new skill directory with a SKILL.md template.
 * Creates the skill directly in the outfit directory as a core skill.
 */

import { Console, Effect } from 'effect'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'

export interface SkillsCreateOptions {
  readonly scope: Lib.Scope
}

const VALID_SEGMENT = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const VALID_NAME = (name: string): boolean =>
  name.split(':').every((segment) => VALID_SEGMENT.test(segment))

const yamlQuote = (value: string): string =>
  /[:#{}&*!|>'"%@`,?]|\[|\]/.test(value)
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value

const template = (name: string): string => `---
name: ${yamlQuote(name)}
description: >-
  TODO: Describe when this skill should be triggered. Include specific phrases,
  commands, or contexts that should activate it.
---

# ${name}

## When to use

TODO: Describe the situations where this skill applies.

## Run

TODO: Add the skill's instructions here.
`

export const skillsCreate = (name: string, options: SkillsCreateOptions) =>
  Effect.gen(function* () {
    if (!name || !VALID_NAME(name)) {
      yield* Console.error('Usage: shan skills create <name> [--scope user|project]')
      yield* Console.error('  Name uses colon syntax (e.g. my-skill, ts:tooling)')
      yield* Console.error(
        '  Each segment must start with a letter and contain only letters, digits, hyphens, or underscores',
      )
      return yield* Effect.fail(new Error('Missing targets'))
    }

    const dir = Lib.outfitDir(options.scope)
    yield* Lib.ensureOutfitDir(dir)
    const entryName = Lib.flattenName(Lib.colonToPath(name))
    const skillDir = path.join(dir, entryName)
    const skillMdPath = path.join(skillDir, 'SKILL.md')

    // Check if skill already exists
    const alreadyExists = yield* Effect.tryPromise(async () => {
      await lstat(skillDir)
      return true
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))

    if (alreadyExists) {
      yield* Console.error(`Skill already exists: ${skillDir}`)
      return yield* Effect.fail(new Error('Skill already exists'))
    }

    // Create directory and write template
    yield* Effect.tryPromise(() => mkdir(skillDir, { recursive: true }))
    yield* Effect.tryPromise(() => writeFile(skillMdPath, template(name)))
    yield* Lib.syncAgentMirrors(options.scope)

    yield* Console.log(skillMdPath)
  })
