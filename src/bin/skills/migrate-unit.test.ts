import { afterAll, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsMigrate, splitName, type MigrateDirs } from './migrate.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-migrate-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)

afterAll(async () => {
  await rm(RAW_BASE, { recursive: true, force: true })
})

const makeDirs = (suffix: string): MigrateDirs => {
  const base = path.join(TEMP_DIR, suffix)
  return {
    oldInventoryDir: path.join(base, 'skill-inventory'),
    oldLoadoutsFile: path.join(base, 'skill-loadouts.yml'),
    libraryDir: path.join(base, 'skills-library'),
    outfitDir: path.join(base, 'skills'),
  }
}

// ── splitName ────────────────────────────────────────────

describe('splitName', () => {
  test('no underscore → standalone', () => {
    expect(splitName('git')).toEqual({ group: null, leaf: 'git' })
  })

  test('with underscore → group + leaf', () => {
    expect(splitName('cc_authoring')).toEqual({ group: 'cc', leaf: 'authoring' })
  })

  test('multiple underscores → split on first only', () => {
    expect(splitName('cc_tips_advanced')).toEqual({ group: 'cc', leaf: 'tips_advanced' })
  })
})

// ── skillsMigrate ────────────────────────────────────────

describe('skillsMigrate', () => {
  test('fails when old inventory does not exist', async () => {
    const d = makeDirs('no-inventory')
    await expect(run(skillsMigrate({ execute: false }, d))).rejects.toThrow('Nothing to migrate')
  })

  test('fails when library already exists', async () => {
    const d = makeDirs('lib-exists')
    await mkdir(d.oldInventoryDir, { recursive: true })
    await mkdir(path.join(d.oldInventoryDir, 'some-skill'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'some-skill', 'SKILL.md'), 'test')
    await mkdir(d.libraryDir, { recursive: true })
    await expect(run(skillsMigrate({ execute: false }, d))).rejects.toThrow(
      'Library already exists',
    )
  })

  test('dry-run prints plan with grouped and standalone skills', async () => {
    const d = makeDirs('dry-run')
    // Create old inventory with grouped + standalone skills
    await mkdir(path.join(d.oldInventoryDir, 'cc_authoring'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'cc_authoring', 'SKILL.md'), 'test')
    await mkdir(path.join(d.oldInventoryDir, 'cc_tips'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'cc_tips', 'SKILL.md'), 'test')
    await mkdir(path.join(d.oldInventoryDir, 'git'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'git', 'SKILL.md'), 'test')
    // Non-directory entry should be skipped
    await writeFile(path.join(d.oldInventoryDir, 'README.md'), 'ignore me')

    await run(skillsMigrate({ execute: false }, d))
    // Dry-run should NOT create the library
    await expect(lstat(d.libraryDir)).rejects.toThrow()
  })

  test('execute migrates skills to hierarchical library', async () => {
    const d = makeDirs('execute')
    // Set up old inventory
    await mkdir(path.join(d.oldInventoryDir, 'cc_authoring'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'cc_authoring', 'SKILL.md'), 'cc authoring')
    await mkdir(path.join(d.oldInventoryDir, 'git'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'git', 'SKILL.md'), 'git skill')

    // Set up outfit with symlinks pointing to old inventory
    await mkdir(d.outfitDir, { recursive: true })
    await symlink(
      path.join(d.oldInventoryDir, 'cc_authoring'),
      path.join(d.outfitDir, 'cc_authoring'),
    )
    await symlink(path.join(d.oldInventoryDir, 'git'), path.join(d.outfitDir, 'git'))

    // Create old loadouts file
    await writeFile(d.oldLoadoutsFile, 'loadout: default\n')

    await run(skillsMigrate({ execute: true }, d))

    // Verify: library has hierarchical structure
    const libEntries = await readdir(d.libraryDir)
    expect(libEntries).toContain('cc')
    expect(libEntries).toContain('git')
    const ccEntries = await readdir(path.join(d.libraryDir, 'cc'))
    expect(ccEntries).toContain('authoring')

    // Verify: symlinks updated
    const ccTarget = await readlink(path.join(d.outfitDir, 'cc_authoring'))
    expect(ccTarget).toContain('skills-library/cc/authoring')
    const gitTarget = await readlink(path.join(d.outfitDir, 'git'))
    expect(gitTarget).toContain('skills-library/git')

    // Verify: old inventory deleted
    await expect(lstat(d.oldInventoryDir)).rejects.toThrow()
    // Verify: old loadouts file deleted
    await expect(lstat(d.oldLoadoutsFile)).rejects.toThrow()
  })

  test('execute handles outfit with non-symlink entries', async () => {
    const d = makeDirs('non-symlink')
    await mkdir(path.join(d.oldInventoryDir, 'alpha'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'alpha', 'SKILL.md'), 'test')
    // Outfit has a real directory (core skill) — should be skipped
    await mkdir(path.join(d.outfitDir, 'core-skill'), { recursive: true })
    // Outfit has a symlink NOT pointing to skill-inventory — should be skipped
    await symlink('/some/other/path', path.join(d.outfitDir, 'other'))

    await run(skillsMigrate({ execute: true }, d))
    // Verify migration succeeded
    const entries = await readdir(d.libraryDir)
    expect(entries).toContain('alpha')
  })

  test('handles no symlinks in outfit', async () => {
    const d = makeDirs('no-outfit')
    await mkdir(path.join(d.oldInventoryDir, 'standalone'), { recursive: true })
    await writeFile(path.join(d.oldInventoryDir, 'standalone', 'SKILL.md'), 'test')
    // No outfit dir at all

    await run(skillsMigrate({ execute: true }, d))
    const entries = await readdir(d.libraryDir)
    expect(entries).toContain('standalone')
  })
})
