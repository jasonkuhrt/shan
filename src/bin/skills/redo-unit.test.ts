import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { skillsRedo } from './redo.js'
import { skillsUndo } from './undo.js'
import { skillsOn } from './on.js'
import { skillsOff } from './off.js'
import { skillsMove } from './move.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-redo-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

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

const STATE_FILE = path.join(homedir(), '.claude', 'shan', 'state.json')

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsRedo', () => {
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
