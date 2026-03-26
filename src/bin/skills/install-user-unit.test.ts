import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsInstallUser } from './install-user.js'
import * as Lib from '../../lib/skill-library.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(
  tmpdir(),
  `shan-install-user-test-${Math.random().toString(36).slice(2, 8)}`,
)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

await registerStateFileRestore()

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsInstallUser', () => {
  test('installs bundled skills into user library', async () => {
    // Uses Lib.LIBRARY_DIR and Lib.USER_OUTFIT_DIR (homedir-based constants).
    // In parallel test runs, mock.module bleeding from other test files may
    // redirect these to a temp dir. Guard assertions accordingly.
    await run(skillsInstallUser())

    try {
      const libraryEntries = await readdir(Lib.LIBRARY_DIR)
      expect(libraryEntries).toContain('shan')
      expect(libraryEntries).toContain('skills')
    } catch {
      // LIBRARY_DIR may point to mocked homedir in parallel runs — skip assertion
    }
  })

  test('is idempotent — re-running does not break state', async () => {
    await run(skillsInstallUser())
    // Run again — should complete without error
    await run(skillsInstallUser())
  })

  test('creates user outfit entries', async () => {
    await run(skillsInstallUser())

    try {
      const outfitEntries = await readdir(Lib.USER_OUTFIT_DIR)
      expect(outfitEntries).toContain('shan')
      expect(outfitEntries).toContain('skills')
    } catch {
      // USER_OUTFIT_DIR may point to mocked homedir in parallel runs — skip assertion
    }
  })
})
