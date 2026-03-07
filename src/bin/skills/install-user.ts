/**
 * shan skills install-user
 *
 * Install shan's bundled user-level skills into ~/.claude/skills-library
 * and equip them at user scope.
 */

import { Console, Effect } from 'effect'
import { cp, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'
import { skillsOn } from './on.js'

const BUNDLED_SKILLS_DIR = path.resolve(import.meta.dir, '../../bundled-skills')
const ROOT_TARGETS = ['shan', 'skills'] as const
const USER_OUTFIT_ENTRIES = ['shan', 'skills', 'skills_change', 'skills_doctor', 'skills_list']

const installBundledSkill = (relativePath: string) =>
  Effect.gen(function* () {
    const sourcePath = path.join(BUNDLED_SKILLS_DIR, relativePath)
    const destPath = path.join(Lib.LIBRARY_DIR, relativePath)

    yield* Effect.tryPromise(() => mkdir(path.dirname(destPath), { recursive: true }))
    yield* Effect.tryPromise(() => rm(destPath, { recursive: true, force: true }))
    yield* Effect.tryPromise(() => cp(sourcePath, destPath, { recursive: true }))
  })

const clearUserOutfitEntries = () =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(Lib.USER_OUTFIT_DIR, { recursive: true }))
    for (const entry of USER_OUTFIT_ENTRIES) {
      const entryPath = path.join(Lib.USER_OUTFIT_DIR, entry)
      yield* Effect.tryPromise(() => rm(entryPath, { recursive: true, force: true }))
    }
  })

export const skillsInstallUser = () =>
  Effect.gen(function* () {
    yield* Console.log('Installing bundled shan skills into ~/.claude/skills-library')

    yield* Effect.tryPromise(() => mkdir(Lib.LIBRARY_DIR, { recursive: true }))
    for (const relativePath of ROOT_TARGETS) {
      yield* installBundledSkill(relativePath)
    }

    yield* Console.log('Replacing existing user-level shan skill entries')
    yield* clearUserOutfitEntries()

    yield* Console.log('Equipping bundled shan skills at user scope')
    yield* skillsOn(ROOT_TARGETS.join(','), { scope: 'user', strict: false })
  })
