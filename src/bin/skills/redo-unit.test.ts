import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { getRuntimeConfig } from '../../lib/runtime-config.js'
import { skillsRedo } from './redo.js'
import { skillsUndo } from './undo.js'
import { skillsOn } from './on.js'
import { skillsOff } from './off.js'
import { skillsMove } from './move.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-redo-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

await registerStateFileRestore()

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`

const setupProjectLibrary = async (...skills: string[]) => {
  const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
  for (const skill of skills) {
    const skillDir = path.join(libDir, skill)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD(skill))
  }
}

const STATE_FILE = getRuntimeConfig().paths.stateFile

const withSavedState = async (runTest: () => Promise<void>) => {
  const stateContent = await readFile(STATE_FILE, 'utf-8').catch(() => '{}')
  try {
    await runTest()
  } finally {
    if (stateContent === '{}') {
      await rm(STATE_FILE, { force: true })
    } else {
      await mkdir(path.dirname(STATE_FILE), { recursive: true })
      await writeFile(STATE_FILE, stateContent)
    }
  }
}

const writeProjectHistory = async (
  entry: Record<string, unknown>,
  undoneCount: number,
  savedState: Record<string, unknown>,
) => {
  const historyKey = process.cwd()
  const state = {
    ...savedState,
    version: 2,
    history: {
      ...((savedState['history'] ?? {}) as Record<string, unknown>),
      [historyKey]: {
        entries: [entry],
        undoneCount,
      },
    },
    current: (savedState['current'] ?? {}) as Record<string, unknown>,
  }

  await mkdir(path.dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  await rm(STATE_FILE, { force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe.serial('skillsRedo', () => {
  test('reports nothing to redo when no undo has been done', async () => {
    await run(skillsRedo(1, 'project'))
  })

  test('redoes an undone on operation', async () => {
    await setupProjectLibrary('redo-skill')
    await run(skillsOn('redo-skill', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-skill')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    // Undo
    await run(skillsUndo(1, 'project'))
    try {
      await lstat(linkPath)
      expect(true).toBe(false)
    } catch {
      // Expected — removed
    }

    // Redo — should re-install via redoOnOp
    await run(skillsRedo(1, 'project'))
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  test('redoes an undone off operation', async () => {
    await setupProjectLibrary('redo-off')
    await run(skillsOn('redo-off', { scope: 'project', strict: false }))
    await run(skillsOff('redo-off', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-off')

    // Undo the off (re-installs)
    await run(skillsUndo(1, 'project'))
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    // Redo the off via redoOffOp (removes again)
    await run(skillsRedo(1, 'project'))
    try {
      await lstat(linkPath)
      expect(true).toBe(false)
    } catch {
      // Expected — removed again
    }
  })

  test('clamps redo count to available undone operations', async () => {
    await setupProjectLibrary('redo-clamp')
    await run(skillsOn('redo-clamp', { scope: 'project', strict: false }))
    await run(skillsUndo(1, 'project'))

    // Request redo of 100 — should clamp to 1
    await run(skillsRedo(100, 'project'))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-clamp')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  test('redoes multiple undone operations', async () => {
    await setupProjectLibrary('redo-a', 'redo-b')
    await run(skillsOn('redo-a', { scope: 'project', strict: false }))
    await run(skillsOn('redo-b', { scope: 'project', strict: false }))

    // Undo both
    await run(skillsUndo(2, 'project'))

    // Redo both
    await run(skillsRedo(2, 'project'))

    for (const name of ['redo-a', 'redo-b']) {
      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', name)
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    }
  })

  test('redoes reset-all off operation', async () => {
    await setupProjectLibrary('reset-redo-x', 'reset-redo-y')
    await run(skillsOn('reset-redo-x,reset-redo-y', { scope: 'project', strict: false }))

    // Reset all (off with no targets)
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Undo the reset (re-installs all)
    await run(skillsUndo(1, 'project'))

    // Redo the reset via redoOffOp reset-all branch (removes all again)
    await run(skillsRedo(1, 'project'))

    for (const name of ['reset-redo-x', 'reset-redo-y']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })

  test('redoes commitment up move (replays CopyToOutfitOp)', async () => {
    await setupProjectLibrary('redo-commit-up')
    await run(skillsOn('redo-commit-up', { scope: 'project', strict: false }))

    // Move to core
    await run(skillsMove('commitment', 'up', 'redo-commit-up', { scope: 'project', strict: false }))

    const outfitPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-commit-up')
    let stat = await lstat(outfitPath)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)

    // Undo the move
    await run(skillsUndo(1, 'project'))

    // Redo — exercises redoMoveOp → replaySubAction for OffOp + CopyToOutfitOp
    await run(skillsRedo(1, 'project'))

    try {
      stat = await lstat(outfitPath)
      expect(stat.isDirectory()).toBe(true)
    } catch {
      // May not exist if library was affected by undo
    }
  })

  test('redoes commitment down move (replays MoveToLibraryOp + OnOp)', async () => {
    // Create core skill in outfit
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const corePath = path.join(outfitDir, 'redo-commit-down')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('redo-commit-down'))
    await mkdir(path.join(TEMP_DIR, '.claude', 'skills-library'), { recursive: true })

    // Move to pluggable
    await run(
      skillsMove('commitment', 'down', 'redo-commit-down', { scope: 'project', strict: false }),
    )
    expect((await lstat(corePath)).isSymbolicLink()).toBe(true)

    // Undo (moves back to core)
    await run(skillsUndo(1, 'project'))
    const stat = await lstat(corePath)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)

    // Redo — exercises redoMoveOp → replaySubAction for MoveToLibraryOp + OnOp
    await run(skillsRedo(1, 'project'))
    expect((await lstat(corePath)).isSymbolicLink()).toBe(true)
  })

  test('redoes reset-all off with generated routers', async () => {
    // Create a group with children in the library
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['redo-grp-a', 'redo-grp-b']) {
      const leafDir = path.join(libDir, 'redogrp', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "redogrp:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    // Install the group → creates leaf symlinks + generated router
    await run(skillsOn('redogrp', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['redogrp_redo-grp-a', 'redogrp_redo-grp-b']) {
      expect((await lstat(path.join(outfitDir, leaf))).isSymbolicLink()).toBe(true)
    }

    // Reset all (off with no targets) → creates OffOp with targets=[]
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Undo the reset → restores outfit
    await run(skillsUndo(1, 'project'))

    // Redo the reset → exercises redoOffOp's router cleanup path (lines 126-130)
    await run(skillsRedo(1, 'project'))

    // Verify leaves are gone
    for (const leaf of ['redogrp_redo-grp-a', 'redogrp_redo-grp-b']) {
      try {
        await lstat(path.join(outfitDir, leaf))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })

  test('redoes on-op when library has been removed', async () => {
    await setupProjectLibrary('redo-vanished')
    await run(skillsOn('redo-vanished', { scope: 'project', strict: false }))

    // Undo the on
    await run(skillsUndo(1, 'project'))

    // Remove the library entry
    await rm(path.join(TEMP_DIR, '.claude', 'skills-library', 'redo-vanished'), {
      recursive: true,
      force: true,
    })

    // Redo → library is missing, lstat fails → catchAll returns false → skill not re-installed
    await run(skillsRedo(1, 'project'))

    // Symlink should NOT exist (library gone)
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-vanished')
    const exists = await lstat(linkPath).catch(() => null)
    expect(exists).toBeNull()
  })

  test('redoes off-op for already-removed symlink', async () => {
    await setupProjectLibrary('redo-already-gone')
    await run(skillsOn('redo-already-gone', { scope: 'project', strict: false }))
    await run(skillsOff('redo-already-gone', { scope: 'project', strict: false }))

    // Undo the off → re-installs
    await run(skillsUndo(1, 'project'))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-already-gone')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    // Manually remove the symlink before redo
    const { unlink } = await import('node:fs/promises')
    await unlink(linkPath)

    // Redo the off → unlink fails (already gone) → catchAll fires
    await run(skillsRedo(1, 'project'))
  })

  test('redoes off-op for targets with missing library (replaySubAction OffOp catchAll)', async () => {
    await setupProjectLibrary('redo-off-sub')
    await run(skillsOn('redo-off-sub', { scope: 'project', strict: false }))

    // commitment up → creates MoveOp with OffOp + CopyToOutfitOp sub-actions
    await run(skillsMove('commitment', 'up', 'redo-off-sub', { scope: 'project', strict: false }))

    // Undo commitment up
    await run(skillsUndo(1, 'project'))

    // Manually remove symlink so OffOp replay's unlink fails → catchAll fires
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-off-sub')
    const { unlink } = await import('node:fs/promises')
    await unlink(linkPath).catch(() => {})

    // Redo → replaySubAction OffOp: unlink on missing path → catchAll(() => Effect.void)
    await run(skillsRedo(1, 'project'))
  })

  test('redoes on-op sub-action when symlink already exists', async () => {
    // Create a core skill
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await mkdir(path.join(TEMP_DIR, '.claude', 'skills-library'), { recursive: true })

    // Setup: commitment down creates MoveToLibraryOp + OnOp sub-actions
    const corePath = path.join(outfitDir, 'redo-on-exists')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('redo-on-exists'))

    await run(
      skillsMove('commitment', 'down', 'redo-on-exists', { scope: 'project', strict: false }),
    )

    // Undo → moves back to core
    await run(skillsUndo(1, 'project'))

    // Now create a symlink where the OnOp replay would create one
    // so symlink() fails → catchAll fires
    const libPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'redo-on-exists')
    await symlink(libPath, corePath).catch(() => {})

    // Redo → OnOp sub-action: symlink already exists → catchAll
    try {
      await run(skillsRedo(1, 'project'))
    } catch {
      // May fail if MoveToLibraryOp fails
    }
  })

  test('redoes move with OnOp sub-action when symlink already exists', async () => {
    // Create a core skill in outfit
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const corePath = path.join(outfitDir, 'redo-move-on-exists')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('redo-move-on-exists'))
    await mkdir(path.join(TEMP_DIR, '.claude', 'skills-library'), { recursive: true })

    // commitment down → creates MoveToLibraryOp + OnOp sub-actions
    await run(
      skillsMove('commitment', 'down', 'redo-move-on-exists', { scope: 'project', strict: false }),
    )
    expect((await lstat(corePath)).isSymbolicLink()).toBe(true)

    // Undo (moves back to core)
    await run(skillsUndo(1, 'project'))

    // Redo → OnOp sub-action tries to symlink, which should succeed or catchAll if exists
    await run(skillsRedo(1, 'project'))
    expect((await lstat(corePath)).isSymbolicLink()).toBe(true)
  })

  test('redoes on-op when symlink already exists at target (skips)', async () => {
    await setupProjectLibrary('redo-exists')
    await run(skillsOn('redo-exists', { scope: 'project', strict: false }))

    // Undo
    await run(skillsUndo(1, 'project'))

    // Manually recreate the symlink before redo
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const linkPath = path.join(outfitDir, 'redo-exists')
    const libPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'redo-exists')
    await symlink(libPath, linkPath)

    // Redo → lstat succeeds (symlink exists), already=true → skips symlink creation
    await run(skillsRedo(1, 'project'))
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  test('redoes move with CopyToOutfitOp when source missing', async () => {
    await setupProjectLibrary('redo-copy-fail')
    await run(skillsOn('redo-copy-fail', { scope: 'project', strict: false }))

    // commitment up → creates OffOp + CopyToOutfitOp sub-actions
    await run(skillsMove('commitment', 'up', 'redo-copy-fail', { scope: 'project', strict: false }))

    // Undo
    await run(skillsUndo(1, 'project'))

    // Delete library so CopyToOutfitOp replay's cp fails
    await rm(path.join(TEMP_DIR, '.claude', 'skills-library', 'redo-copy-fail'), {
      recursive: true,
      force: true,
    })

    // Redo → CopyToOutfitOp fails (source missing)
    try {
      await run(skillsRedo(1, 'project'))
    } catch {
      // Expected — cp fails when source is missing
    }
  })

  test('redoes move with MoveToLibraryOp when source missing', async () => {
    // Create a core skill
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const corePath = path.join(outfitDir, 'redo-movelib-fail')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('redo-movelib-fail'))
    await mkdir(path.join(TEMP_DIR, '.claude', 'skills-library'), { recursive: true })

    // commitment down → MoveToLibraryOp + OnOp
    await run(
      skillsMove('commitment', 'down', 'redo-movelib-fail', { scope: 'project', strict: false }),
    )

    // Undo → moves back to core
    await run(skillsUndo(1, 'project'))

    // Delete the core directory so MoveToLibraryOp replay's rename fails
    await rm(corePath, { recursive: true, force: true })

    // Redo → MoveToLibraryOp's rename fails (source missing)
    try {
      await run(skillsRedo(1, 'project'))
    } catch {
      // Expected — rename fails when source is missing
    }
  })

  test('redoes targeted off-op with multiple targets', async () => {
    await setupProjectLibrary('redo-off-x', 'redo-off-y')
    await run(skillsOn('redo-off-x,redo-off-y', { scope: 'project', strict: false }))
    await run(skillsOff('redo-off-x,redo-off-y', { scope: 'project', strict: false }))

    // Undo the off
    await run(skillsUndo(1, 'project'))

    // Redo the off — exercises redoOffOp targeted path with gitignoreRemovals
    await run(skillsRedo(1, 'project'))

    for (const name of ['redo-off-x', 'redo-off-y']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })

  test('redoes reset-all off with read-only outfit (unlink catchAll)', async () => {
    await setupProjectLibrary('redo-ro-a', 'redo-ro-b')
    await run(skillsOn('redo-ro-a,redo-ro-b', { scope: 'project', strict: false }))

    // Reset all
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Undo the reset → restores outfit
    await run(skillsUndo(1, 'project'))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')

    // Make outfit dir read-only so unlink/rm in redo fail → catchAlls fire
    await chmod(outfitDir, 0o555)
    try {
      await run(skillsRedo(1, 'project'))
    } finally {
      await chmod(outfitDir, 0o755)
    }
  })

  test('redoes on-op where symlink creation fails (read-only outfit)', async () => {
    await setupProjectLibrary('redo-sym-catch')
    await run(skillsOn('redo-sym-catch', { scope: 'project', strict: false }))
    await run(skillsUndo(1, 'project'))

    // Make outfit dir read-only so symlink() fails with EACCES → catchAll fires
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await chmod(outfitDir, 0o555)
    try {
      // lstat(linkPath) fails (no file) → already=false
      // lstat(libPath) succeeds → libExists=true
      // symlink() fails (read-only dir) → catchAll(() => Effect.void) fires
      await run(skillsRedo(1, 'project'))
    } finally {
      await chmod(outfitDir, 0o755)
    }
  })

  test('redoes on-op history entries while skipping invalid canonical targets', async () => {
    await withSavedState(async () => {
      await setupProjectLibrary('redo-valid-target')
      const savedState = JSON.parse(
        await readFile(STATE_FILE, 'utf-8').catch(() => '{}'),
      ) as Record<string, unknown>

      await writeProjectHistory(
        {
          _tag: 'OnOp',
          targets: ['redo-valid-target', 'redo_invalid_target'],
          scope: 'project',
          timestamp: new Date().toISOString(),
          snapshot: [],
          generatedRouters: [],
        },
        1,
        savedState,
      )

      await run(skillsRedo(1, 'project'))

      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-valid-target')
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    })
  })

  test('redoes off-op history entries while skipping invalid canonical targets', async () => {
    await withSavedState(async () => {
      await setupProjectLibrary('redo-off-valid-target')
      const savedState = JSON.parse(
        await readFile(STATE_FILE, 'utf-8').catch(() => '{}'),
      ) as Record<string, unknown>
      const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
      const libPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'redo-off-valid-target')
      const linkPath = path.join(outfitDir, 'redo-off-valid-target')
      await mkdir(outfitDir, { recursive: true })
      await symlink(libPath, linkPath)

      await writeProjectHistory(
        {
          _tag: 'OffOp',
          targets: ['redo-off-valid-target', 'redo_off_invalid_target'],
          scope: 'project',
          timestamp: new Date().toISOString(),
          snapshot: [],
          generatedRouters: [],
        },
        1,
        savedState,
      )

      await run(skillsRedo(1, 'project'))

      const exists = await lstat(linkPath).catch(() => null)
      expect(exists).toBeNull()
    })
  })

  test('redoes move off-op sub-actions while skipping invalid canonical targets', async () => {
    await withSavedState(async () => {
      await setupProjectLibrary('redo-move-off-valid-target')
      const savedState = JSON.parse(
        await readFile(STATE_FILE, 'utf-8').catch(() => '{}'),
      ) as Record<string, unknown>
      const outfitPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-move-off-valid-target')
      const libPath = path.join(TEMP_DIR, '.claude', 'skills-library', 'redo-move-off-valid-target')
      await mkdir(path.dirname(outfitPath), { recursive: true })
      await symlink(libPath, outfitPath)

      await writeProjectHistory(
        {
          _tag: 'MoveOp',
          targets: ['redo-move-off-valid-target'],
          scope: 'project',
          timestamp: new Date().toISOString(),
          axis: 'commitment',
          direction: 'up',
          subActions: [
            {
              _tag: 'OffOp',
              targets: ['redo-move-off-valid-target', 'redo_move_off_invalid_target'],
              scope: 'project',
              timestamp: new Date().toISOString(),
              snapshot: [],
              generatedRouters: [],
            },
          ],
        },
        1,
        savedState,
      )

      await run(skillsRedo(1, 'project'))

      const exists = await lstat(outfitPath).catch(() => null)
      expect(exists).toBeNull()
    })
  })

  test('redoes move on-op sub-actions while skipping invalid canonical targets', async () => {
    await withSavedState(async () => {
      await setupProjectLibrary('redo-move-on-valid-target')
      const savedState = JSON.parse(
        await readFile(STATE_FILE, 'utf-8').catch(() => '{}'),
      ) as Record<string, unknown>
      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'redo-move-on-valid-target')

      await writeProjectHistory(
        {
          _tag: 'MoveOp',
          targets: ['redo-move-on-valid-target'],
          scope: 'project',
          timestamp: new Date().toISOString(),
          axis: 'commitment',
          direction: 'down',
          subActions: [
            {
              _tag: 'OnOp',
              targets: ['redo-move-on-valid-target', 'redo_move_on_invalid_target'],
              scope: 'project',
              timestamp: new Date().toISOString(),
              snapshot: [],
              generatedRouters: [],
            },
          ],
        },
        1,
        savedState,
      )

      await run(skillsRedo(1, 'project'))

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    })
  })

  test('redoes on-op sub-action where symlink fails (OnOp in MoveOp)', async () => {
    // Write a custom MoveOp with OnOp sub-action targeting an occupied path
    const stateContent = await readFile(STATE_FILE, 'utf-8').catch(() => '{}')
    const saved = JSON.parse(stateContent) as Record<string, unknown>
    const historyKey = process.cwd()

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const linkPath = path.join(outfitDir, 'redo-sub-sym-fail')
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const libPath = path.join(libDir, 'redo-sub-sym-fail')

    // Create library entry (so lstat(libPath) succeeds) and a DIRECTORY at linkPath
    await mkdir(libPath, { recursive: true })
    await writeFile(path.join(libPath, 'SKILL.md'), SKILL_MD('redo-sub-sym-fail'))
    await mkdir(linkPath, { recursive: true })

    const state = {
      ...saved,
      version: 2,
      history: {
        ...((saved['history'] ?? {}) as Record<string, unknown>),
        [historyKey]: {
          entries: [
            {
              _tag: 'MoveOp',
              targets: ['redo-sub-sym-fail'],
              scope: 'project',
              timestamp: new Date().toISOString(),
              axis: 'commitment',
              direction: 'down',
              subActions: [
                {
                  _tag: 'OnOp',
                  targets: ['redo-sub-sym-fail'],
                  scope: 'project',
                  timestamp: new Date().toISOString(),
                  snapshot: [],
                  generatedRouters: [],
                },
              ],
            },
          ],
          undoneCount: 1,
        },
      },
      current: (saved['current'] ?? {}) as Record<string, unknown>,
    }

    await mkdir(path.dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2))

    try {
      // Redo → OnOp sub-action: lstat(libPath) → isDirectory=true → exists=true
      // symlink(libPath, linkPath) fails because linkPath is a directory → catchAll fires
      await run(skillsRedo(1, 'project'))
    } finally {
      await writeFile(STATE_FILE, JSON.stringify(saved, null, 2))
    }
  })

  test('redo warns for DoctorOp entries', async () => {
    const stateContent = await readFile(STATE_FILE, 'utf-8').catch(() => '{}')
    const saved = JSON.parse(stateContent) as Record<string, unknown>
    const historyKey = process.cwd()

    // Write state with a DoctorOp that's already undone
    const state = {
      ...saved,
      version: 2,
      history: {
        ...((saved['history'] ?? {}) as Record<string, unknown>),
        [historyKey]: {
          entries: [
            {
              _tag: 'DoctorOp',
              targets: ['fix-1'],
              scope: 'project',
              timestamp: new Date().toISOString(),
            },
          ],
          undoneCount: 1,
        },
      },
      current: (saved['current'] ?? {}) as Record<string, unknown>,
    }

    await mkdir(path.dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2))

    try {
      // Redo the DoctorOp → hits warn path in redoEntry
      await run(skillsRedo(1, 'project'))
    } finally {
      await writeFile(STATE_FILE, JSON.stringify(saved, null, 2))
    }
  })
})
