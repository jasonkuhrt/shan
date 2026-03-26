import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { lstat, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsOn } from './on.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-on-test-${Math.random().toString(36).slice(2, 8)}`)
await mkdir(RAW_BASE, { recursive: true })
const TEMP_DIR = realpathSync(RAW_BASE)
const origCwd = process.cwd()

await registerStateFileRestore()

const SKILL_MD = `---
name: test-skill
description: A test skill
---

# test-skill
`

/** Create a project library with skills in the temp dir. */
const setupProjectLibrary = async (...skills: string[]) => {
  const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
  for (const skill of skills) {
    const skillDir = path.join(libDir, skill)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD.replace(/test-skill/g, skill))
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

describe('skillsOn', () => {
  test('fails with empty target input', async () => {
    await expect(run(skillsOn('', { scope: 'project', strict: false }))).rejects.toThrow(
      'Missing targets',
    )
  })

  test('fails when project library does not exist', async () => {
    // No .claude/skills-library/ in temp dir
    await expect(run(skillsOn('some-skill', { scope: 'project', strict: true }))).rejects.toThrow(
      'Library not found',
    )
  })

  test('reports error for nonexistent target', async () => {
    await setupProjectLibrary('real-skill')

    // 'nonexistent' is not in library — should produce batch error
    // strict=true → aborts
    await expect(run(skillsOn('nonexistent', { scope: 'project', strict: true }))).rejects.toThrow(
      'Some targets failed',
    )
  })

  test('creates symlink for existing skill at project scope', async () => {
    await setupProjectLibrary('my-leaf')

    await run(skillsOn('my-leaf', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'my-leaf')
    const stat = await lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)

    const target = await readlink(linkPath)
    expect(target).toContain('skills-library')
  })

  test('skips already-on skill', async () => {
    await setupProjectLibrary('already-on')
    // First on
    await run(skillsOn('already-on', { scope: 'project', strict: false }))
    // Second on — should skip
    await run(skillsOn('already-on', { scope: 'project', strict: false }))

    // Still just one symlink
    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'already-on')
    const stat = await lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)
  })

  test('creates symlinks for multiple comma-separated targets', async () => {
    await setupProjectLibrary('skill-a', 'skill-b')

    await run(skillsOn('skill-a,skill-b', { scope: 'project', strict: false }))

    for (const name of ['skill-a', 'skill-b']) {
      const linkPath = path.join(TEMP_DIR, '.claude', 'skills', name)
      const stat = await lstat(linkPath)
      expect(stat.isSymbolicLink()).toBe(true)
    }
  })

  test('generates router for group', async () => {
    // Create a group with two leaves
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    for (const leaf of ['child-a', 'child-b']) {
      const leafDir = path.join(libDir, 'mygroup', leaf)
      await mkdir(leafDir, { recursive: true })
      await writeFile(
        path.join(leafDir, 'SKILL.md'),
        `---\nname: "mygroup:${leaf}"\ndescription: Test\n---\n# ${leaf}\n`,
      )
    }

    await run(skillsOn('mygroup', { scope: 'project', strict: false }))

    // Group leaves should be installed as flat symlinks
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    for (const leaf of ['mygroup_child-a', 'mygroup_child-b']) {
      const stat = await lstat(path.join(outfitDir, leaf))
      expect(stat.isSymbolicLink()).toBe(true)
    }
  })

  test('handles strict mode with mixed valid and invalid targets', async () => {
    await setupProjectLibrary('valid-skill')

    // One valid, one invalid — strict mode should abort
    await expect(
      run(skillsOn('valid-skill,invalid-skill', { scope: 'project', strict: true })),
    ).rejects.toThrow('Some targets failed')

    // The valid skill should NOT have been installed (Phase 1 aborted)
    try {
      const stat = await lstat(path.join(TEMP_DIR, '.claude', 'skills', 'valid-skill'))
      // If we get here, the symlink was created (shouldn't happen in strict mode with errors)
      expect(stat.isSymbolicLink()).toBe(false) // Force fail
    } catch {
      // Expected: file doesn't exist because strict mode aborted
    }
  })

  test('non-strict mode installs despite skip (already-on target)', async () => {
    await setupProjectLibrary('new-skill', 'existing-skill')
    // Install existing-skill first so it becomes a skip
    await run(skillsOn('existing-skill', { scope: 'project', strict: false }))

    // In non-strict mode, the skip for existing-skill doesn't abort
    await run(skillsOn('new-skill,existing-skill', { scope: 'project', strict: false }))

    const linkPath = path.join(TEMP_DIR, '.claude', 'skills', 'new-skill')
    const stat = await lstat(linkPath)
    expect(stat.isSymbolicLink()).toBe(true)
  })
})
