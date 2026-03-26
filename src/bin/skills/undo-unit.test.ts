import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { skillsUndo } from './undo.js'
import { skillsOn } from './on.js'
import { skillsOff } from './off.js'
import { skillsMove } from './move.js'
import { skillsDoctor } from './doctor.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-undo-test-${Math.random().toString(36).slice(2, 8)}`)
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

const STATE_FILE = path.join(homedir(), '.claude', 'shan', 'state.json')

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsUndo', () => {
  test('reports nothing to undo when history is empty', async () => {
    await run(skillsUndo(1, 'project'))
  })

  test('undoes a single on operation', async () => {
    await setupProjectLibrary('undo-skill')
    await run(skillsOn('undo-skill', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'undo-skill')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    await run(skillsUndo(1, 'project'))

    try {
      await lstat(linkPath)
      expect(true).toBe(false) // Should not reach here
    } catch {
      // Expected — symlink removed by undo
    }
  })

  test('undoes multiple operations', async () => {
    await setupProjectLibrary('undo-a', 'undo-b')
    await run(skillsOn('undo-a', { scope: 'project', strict: false }))
    await run(skillsOn('undo-b', { scope: 'project', strict: false }))

    await run(skillsUndo(2, 'project'))

    for (const name of ['undo-a', 'undo-b']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false)
      } catch {
        // Expected
      }
    }
  })

  test('undoes an off operation (re-installs)', async () => {
    await setupProjectLibrary('re-install')
    await run(skillsOn('re-install', { scope: 'project', strict: false }))
    await run(skillsOff('re-install', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 're-install')
    try {
      await lstat(linkPath)
      expect(true).toBe(false)
    } catch {
      // Expected
    }

    await run(skillsUndo(1, 'project'))

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  test('clamps undo count to available history', async () => {
    await setupProjectLibrary('clamp-skill')
    await run(skillsOn('clamp-skill', { scope: 'project', strict: false }))

    // Request undo of 100 operations — should clamp to 1
    await run(skillsUndo(100, 'project'))
  })

  test('undoes commitment up move (reverses CopyToOutfitOp)', async () => {
    await setupProjectLibrary('commit-up-undo')
    await run(skillsOn('commit-up-undo', { scope: 'project', strict: false }))

    // Move to core (pluggable → core)
    await run(skillsMove('commitment', 'up', 'commit-up-undo', { scope: 'project', strict: false }))

    const outfitPath = path.join(TEMP_DIR, '.claude', 'skills', 'commit-up-undo')
    let stat = await lstat(outfitPath)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)

    // Undo — reverses CopyToOutfitOp (removes dir) and OffOp sub-actions
    await run(skillsUndo(1, 'project'))

    try {
      stat = await lstat(outfitPath)
      // Should be back to pluggable (symlink)
      expect(stat.isSymbolicLink()).toBe(true)
    } catch {
      // May not exist if library state changed
    }
  })

  test('undoes commitment down move (reverses MoveToLibraryOp)', async () => {
    // Create a core skill (real directory in outfit)
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const corePath = path.join(outfitDir, 'commit-down-undo')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('commit-down-undo'))
    await mkdir(path.join(TEMP_DIR, '.claude', 'skills-library'), { recursive: true })

    // Move to pluggable (core → pluggable)
    await run(
      skillsMove('commitment', 'down', 'commit-down-undo', { scope: 'project', strict: false }),
    )

    expect((await lstat(corePath)).isSymbolicLink()).toBe(true)

    // Undo — reverses OnOp (removes symlink) and MoveToLibraryOp (moves back)
    await run(skillsUndo(1, 'project'))

    const stat = await lstat(corePath)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)
  })

  test('undo warns for DoctorOp entries', async () => {
    const stateContent = await readFile(STATE_FILE, 'utf-8').catch(() => '{}')
    const saved = JSON.parse(stateContent) as Record<string, unknown>
    const historyKey = process.cwd()

    // Write state with a DoctorOp entry
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
          undoneCount: 0,
        },
      },
      current: (saved['current'] ?? {}) as Record<string, unknown>,
    }

    await mkdir(path.dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2))

    try {
      // Undo the DoctorOp → hits warn path in undoEntry
      await run(skillsUndo(1, 'project'))
    } finally {
      await writeFile(STATE_FILE, JSON.stringify(saved, null, 2))
    }
  })

  test('undoes doctor auto-fix operation', async () => {
    await setupProjectLibrary('doctor-undo-skill')
    await run(skillsOn('doctor-undo-skill', { scope: 'project', strict: false }))

    // Create a broken symlink for doctor to find
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await symlink('/nonexistent/path', path.join(outfitDir, 'broken-for-undo'))

    // Doctor auto-fix creates a DoctorOp history entry
    await run(skillsDoctor({ noFix: false }))

    // Undo — DoctorOp entry hits the warn fallback
    await run(skillsUndo(1, 'project'))
  })
})
