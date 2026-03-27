/**
 * Migration: ~/.claude/skill-inventory/ (flat) → ~/.claude/skills-library/ (hierarchical)
 *
 * Algorithm:
 * 1. Split name on underscores: ts_tooling → group "ts", leaf "tooling"
 * 2. Names without underscores stay at root: git → skills-library/git/
 * 3. Names with underscores become nested: cc_tips_advanced → skills-library/cc/tips/advanced/
 * 4. Update all symlinks in ~/.claude/skills/ to point to new locations
 * 5. Delete skill-inventory/ and skill-loadouts.yml after migration
 *
 * Special cases handled during migration:
 * - Symlinks with custom target names (e.g. cc_tips → tips, gdrive → uploading-to-gdrive)
 *   are resolved using the actual inventory directory name
 * - Existing real directories in skills/ (core skills) are untouched
 */

import { Console, Effect } from 'effect'
import { lstat, mkdir, readdir, readlink, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as Lib from '../../lib/skill-library.js'

export interface MigrateDirs {
  oldInventoryDir: string
  oldLoadoutsFile: string
  libraryDir: string
  outfitDir: string
}

const defaultDirs = (): MigrateDirs => ({
  oldInventoryDir: path.join(homedir(), '.claude/skill-inventory'),
  oldLoadoutsFile: path.join(homedir(), '.claude/skill-loadouts.yml'),
  libraryDir: Lib.LIBRARY_DIR,
  outfitDir: Lib.USER_OUTFIT_DIR,
})

interface MigrationPlan {
  moves: Array<{
    oldName: string // name in skill-inventory/
    newRelPath: string // path in skills-library/ (e.g. "cc/authoring")
    oldPath: string
    newPath: string
  }>
  symlinkUpdates: Array<{
    symlinkName: string // name in skills/ outfit
    oldTarget: string
    newTarget: string
    symlinkPath: string
  }>
  deletes: string[] // files/dirs to delete after migration
}

/**
 * Split an inventory name on underscores to determine hierarchy.
 * Names without underscores stay at root.
 */
export const splitName = (name: string): { group: string | null; leaf: string } => {
  const segments = name.split('_')
  if (segments.length === 1) return { group: null, leaf: name }
  if (segments.some((segment) => segment.length === 0)) return { group: null, leaf: name }

  const [group, ...rest] = segments
  if (!group) return { group: null, leaf: name }
  return { group, leaf: rest.join('/') }
}

export const skillsMigrate = (options: { execute: boolean }, dirs?: MigrateDirs) =>
  Effect.gen(function* () {
    const d = dirs ?? defaultDirs()

    // Check old inventory exists
    const oldExists = yield* Effect.tryPromise(async () => {
      const stat = await lstat(d.oldInventoryDir)
      return stat.isDirectory()
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))

    if (!oldExists) {
      yield* Console.error(`Old inventory not found: ${d.oldInventoryDir}`)
      yield* Console.error('Nothing to migrate.')
      return yield* Effect.fail(new Error('Nothing to migrate'))
    }

    // Check new library doesn't already exist
    const newExists = yield* Effect.tryPromise(async () => {
      const stat = await lstat(d.libraryDir)
      return stat.isDirectory()
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (newExists) {
      yield* Console.error(`Library already exists: ${d.libraryDir}`)
      yield* Console.error('Migration already complete, or clean up first.')
      return yield* Effect.fail(new Error('Library already exists'))
    }

    // Build migration plan
    const plan = yield* buildPlan(d)

    if (!options.execute) {
      yield* printPlan(plan, d)
      yield* Console.log('')
      yield* Console.log('Run with --execute to perform the migration.')
      return
    }

    yield* executePlan(plan, d)
  })

const buildPlan = (d: MigrateDirs) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() => readdir(d.oldInventoryDir))
    const plan: MigrationPlan = { moves: [], symlinkUpdates: [], deletes: [] }

    // Plan moves
    for (const name of entries.sort()) {
      const oldPath = path.join(d.oldInventoryDir, name)
      const stat = yield* Effect.tryPromise(() => lstat(oldPath))
      if (!stat.isDirectory()) continue

      const { group, leaf } = splitName(name)
      const newRelPath = group ? `${group}/${leaf}` : leaf
      const newPath = path.join(d.libraryDir, newRelPath)

      plan.moves.push({ oldName: name, newRelPath, oldPath, newPath })
    }

    // Plan symlink updates
    const skillsEntries = yield* Effect.tryPromise(() => readdir(d.outfitDir)).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[])),
    )

    for (const name of skillsEntries.sort()) {
      const symlinkPath = path.join(d.outfitDir, name)
      const stat = yield* Effect.tryPromise(() => lstat(symlinkPath))
      if (!stat.isSymbolicLink()) continue

      const oldTarget = yield* Effect.tryPromise(() => readlink(symlinkPath)).pipe(
        Effect.catchAll(() => Effect.succeed('')),
      )
      if (!oldTarget.includes('skill-inventory')) continue

      // Figure out which inventory item this symlink points to
      const inventoryName = path.basename(oldTarget)
      const move = plan.moves.find((m) => m.oldName === inventoryName)
      if (!move) continue

      plan.symlinkUpdates.push({
        symlinkName: name,
        oldTarget,
        newTarget: move.newPath,
        symlinkPath,
      })
    }

    // Plan deletes
    plan.deletes.push(d.oldInventoryDir)

    const loadoutsExist = yield* Effect.tryPromise(async () => {
      const stat = await lstat(d.oldLoadoutsFile)
      return stat.isFile()
    }).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (loadoutsExist) {
      plan.deletes.push(d.oldLoadoutsFile)
    }

    return plan
  })

const printPlan = (plan: MigrationPlan, d: MigrateDirs) =>
  Effect.gen(function* () {
    yield* Console.log('Migration Plan (dry run)')
    yield* Console.log('═'.repeat(50))
    yield* Console.log('')

    // Group moves by group
    const groups = new Map<string, string[]>()
    const standalone: string[] = []
    for (const move of plan.moves) {
      const { group } = splitName(move.oldName)
      if (group) {
        const existing = groups.get(group) ?? []
        existing.push(move.newRelPath)
        groups.set(group, existing)
      } else {
        standalone.push(move.newRelPath)
      }
    }

    yield* Console.log(`Create: ${d.libraryDir}`)
    yield* Console.log('')

    if (groups.size > 0) {
      yield* Console.log('Groups:')
      for (const [group, paths] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        yield* Console.log(`  ${group}/`)
        for (const p of paths.sort()) {
          yield* Console.log(`    ${p}/`)
        }
      }
      yield* Console.log('')
    }

    if (standalone.length > 0) {
      yield* Console.log('Standalone:')
      for (const p of standalone.sort()) {
        yield* Console.log(`  ${p}/`)
      }
      yield* Console.log('')
    }

    yield* Console.log(`Symlinks to update: ${plan.symlinkUpdates.length}`)
    yield* Console.log(`Items to delete: ${plan.deletes.join(', ')}`)
    yield* Console.log('')
    yield* Console.log(`Total: ${plan.moves.length} skills migrated`)
  })

const executePlan = (plan: MigrationPlan, d: MigrateDirs) =>
  Effect.gen(function* () {
    yield* Console.log('Migrating skill inventory to hierarchical library...')
    yield* Console.log('')

    // 1. Create library directory
    yield* Effect.tryPromise(() => mkdir(d.libraryDir, { recursive: true }))

    // 2. Create group directories and move skills
    const groupDirs = new Set<string>()
    for (const move of plan.moves) {
      const parentDir = path.dirname(move.newPath)
      if (!groupDirs.has(parentDir)) {
        yield* Effect.tryPromise(() => mkdir(parentDir, { recursive: true }))
        groupDirs.add(parentDir)
      }
      yield* Effect.tryPromise(() => rename(move.oldPath, move.newPath))
      yield* Console.log(`  move: ${move.oldName} → ${move.newRelPath}/`)
    }

    // 3. Update symlinks
    yield* Console.log('')
    for (const update of plan.symlinkUpdates) {
      yield* Effect.tryPromise(() => unlink(update.symlinkPath)).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* Effect.tryPromise(() => symlink(update.newTarget, update.symlinkPath))
      yield* Console.log(`  link: ${update.symlinkName} → ${update.newTarget}`)
    }

    // 4. Delete old files
    yield* Console.log('')
    for (const toDelete of plan.deletes) {
      yield* Effect.tryPromise(() => rm(toDelete, { recursive: true })).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* Console.log(`  delete: ${toDelete}`)
    }

    yield* Console.log('')
    yield* Console.log(`Migrated ${plan.moves.length} skills to ${d.libraryDir}`)
    yield* Console.log('')
    yield* Console.log("Run 'shan skills doctor' to verify the migration.")
  })
