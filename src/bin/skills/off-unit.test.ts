import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsOff } from './off.js'
import { skillsOn } from './on.js'
import { skillsUndo } from './undo.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-off-test-${Math.random().toString(36).slice(2, 8)}`)
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

beforeEach(async () => {
  await rm(path.join(TEMP_DIR, '.claude'), { recursive: true, force: true })
  process.chdir(TEMP_DIR)
})

afterAll(async () => {
  process.chdir(origCwd)
  await rm(RAW_BASE, { recursive: true, force: true })
})

describe('skillsOff', () => {
  test('fails when project library does not exist', async () => {
    await expect(run(skillsOff('some-skill', { scope: 'project', strict: false }))).rejects.toThrow(
      'Library not found',
    )
  })

  test('reports error for nonexistent target', async () => {
    await setupProjectLibrary('real-skill')

    await expect(run(skillsOff('nonexistent', { scope: 'project', strict: true }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('removes symlink for installed skill', async () => {
    await setupProjectLibrary('removable')
    await run(skillsOn('removable', { scope: 'project', strict: false }))

    // Verify it exists
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'removable')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)

    // Turn off
    await run(skillsOff('removable', { scope: 'project', strict: false }))

    // Verify it's gone
    try {
      await lstat(linkPath)
      expect(true).toBe(false) // Should not reach here
    } catch {
      // Expected — symlink removed
    }
  })

  test('skips already-off skill', async () => {
    await setupProjectLibrary('off-skill')

    // Never turned on — should skip
    await run(skillsOff('off-skill', { scope: 'project', strict: false }))
  })

  test('reset-all removes all pluggable skills', async () => {
    await setupProjectLibrary('skill-x', 'skill-y')
    await run(skillsOn('skill-x,skill-y', { scope: 'project', strict: false }))

    // Verify both exist
    for (const name of ['skill-x', 'skill-y']) {
      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', name)
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    }

    // Reset all (empty target input)
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Verify both removed
    for (const name of ['skill-x', 'skill-y']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false) // Should not reach here
      } catch {
        // Expected
      }
    }
  })

  test('does not remove core (real directory) skills', async () => {
    await setupProjectLibrary('some-lib-skill')
    // Create a core skill (real directory, not symlink)
    const coreDir = path.join(TEMP_DIR, '.claude', 'skills', 'core-skill')
    await mkdir(coreDir, { recursive: true })
    await writeFile(path.join(coreDir, 'SKILL.md'), SKILL_MD('core-skill'))

    // Reset all — core should survive
    await run(skillsOff('', { scope: 'project', strict: false }))

    const stat = await lstat(coreDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('handles multiple comma-separated targets', async () => {
    await setupProjectLibrary('off-a', 'off-b')
    await run(skillsOn('off-a,off-b', { scope: 'project', strict: false }))

    await run(skillsOff('off-a,off-b', { scope: 'project', strict: false }))

    for (const name of ['off-a', 'off-b']) {
      try {
        await lstat(path.join(TEMP_DIR, '.claude', 'skills', name))
        expect(true).toBe(false)
      } catch {
        // Expected
      }
    }
  })

  test('errors when targeting core skill (real directory)', async () => {
    await setupProjectLibrary('core-off')
    // Also create a core version in outfit (real directory)
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    const corePath = path.join(outfitDir, 'core-off')
    await mkdir(corePath, { recursive: true })
    await writeFile(path.join(corePath, 'SKILL.md'), SKILL_MD('core-off'))

    await expect(run(skillsOff('core-off', { scope: 'project', strict: true }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('cleans up group router on off', async () => {
    // Create group with children in library
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['child-a', 'child-b']) {
      const leafDir = path.join(libDir, 'offgroup', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "offgroup:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    // Install group (creates leaf symlinks and possibly router)
    await run(skillsOn('offgroup', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['offgroup_child-a', 'offgroup_child-b']) {
      expect((await lstat(path.join(outfitDir, leaf))).isSymbolicLink()).toBe(true)
    }

    // Turn off the group — exercises cleanupRouter
    await run(skillsOff('offgroup', { scope: 'project', strict: false }))

    // Verify leaf symlinks removed
    for (const leaf of ['offgroup_child-a', 'offgroup_child-b']) {
      try {
        await lstat(path.join(outfitDir, leaf))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })

  test('strict mode aborts with mix of valid and invalid', async () => {
    await setupProjectLibrary('off-valid')
    await run(skillsOn('off-valid', { scope: 'project', strict: false }))

    // One valid target, one invalid — strict mode should abort
    await expect(
      run(skillsOff('off-valid,off-invalid', { scope: 'project', strict: true })),
    ).rejects.toThrow('Some targets failed')

    // Valid skill should NOT have been removed (abort before Phase 2)
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'off-valid')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  test('off after undo trims undone history entries', async () => {
    await setupProjectLibrary('trim-off-a', 'trim-off-b')
    await run(skillsOn('trim-off-a', { scope: 'project', strict: false }))
    await run(skillsOn('trim-off-b', { scope: 'project', strict: false }))

    // Undo last on → undoneCount = 1
    await run(skillsUndo(1, 'project'))

    // Off the remaining skill → records history with undoneCount > 0, triggers splice
    await run(skillsOff('trim-off-a', { scope: 'project', strict: false }))

    // Verify skill is removed
    try {
      await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'trim-off-a'))
      expect(true).toBe(false)
    } catch {
      // Expected — removed
    }
  })

  test('reset-all after undo trims undone history entries', async () => {
    await setupProjectLibrary('resetundo-a', 'resetundo-b')
    await run(skillsOn('resetundo-a', { scope: 'project', strict: false }))
    await run(skillsOn('resetundo-b', { scope: 'project', strict: false }))

    // Undo last on → undoneCount = 1
    await run(skillsUndo(1, 'project'))

    // Reset all → exercises resetAll path with undoneCount > 0
    await run(skillsOff('', { scope: 'project', strict: false }))
  })

  test('reset-all cleans up generated routers', async () => {
    // Create group with children in library
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['child-x', 'child-y']) {
      const leafDir = path.join(libDir, 'resetgrp', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "resetgrp:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    // Install group
    await run(skillsOn('resetgrp', { scope: 'project', strict: false }))

    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['resetgrp_child-x', 'resetgrp_child-y']) {
      expect((await lstat(path.join(outfitDir, leaf))).isSymbolicLink()).toBe(true)
    }

    // Reset all — exercises resetAll router cleanup path
    await run(skillsOff('', { scope: 'project', strict: false }))

    // Verify leaf symlinks removed
    for (const leaf of ['resetgrp_child-x', 'resetgrp_child-y']) {
      try {
        await lstat(path.join(outfitDir, leaf))
        expect(true).toBe(false)
      } catch {
        // Expected — removed
      }
    }
  })
})
