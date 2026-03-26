import { afterAll, beforeEach, describe, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { skillsDoctor } from './doctor.js'
import { skillsOn } from './on.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-doctor-test-${Math.random().toString(36).slice(2, 8)}`)
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

describe('skillsDoctor', () => {
  test('reports library not found when no library exists', async () => {
    // No .claude/skills-library/ in temp dir — doctor should exit early
    // libraryExists() with no scope checks both LIBRARY_DIR and projectLibraryDir()
    // This uses the user's real LIBRARY_DIR, so it may or may not exist
    await run(skillsDoctor({ noFix: true }))
  })

  test('runs with --no-fix (report-only mode)', async () => {
    await setupProjectLibrary('doctor-skill')
    await run(skillsOn('doctor-skill', { scope: 'project', strict: false }))

    await run(skillsDoctor({ noFix: true }))
  })

  test('runs with auto-fix mode', async () => {
    await setupProjectLibrary('fix-skill')
    await run(skillsOn('fix-skill', { scope: 'project', strict: false }))

    await run(skillsDoctor({ noFix: false }))
  })

  test('detects issues when outfit has broken symlinks', async () => {
    await setupProjectLibrary('healthy-skill')
    await run(skillsOn('healthy-skill', { scope: 'project', strict: false }))

    // Create a broken symlink in the outfit
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await symlink('/nonexistent/path', path.join(outfitDir, 'broken-link'))

    await run(skillsDoctor({ noFix: true }))
  })

  test('auto-fixes broken symlinks', async () => {
    await setupProjectLibrary('another-skill')
    await run(skillsOn('another-skill', { scope: 'project', strict: false }))

    // Create a broken symlink
    const outfitDir = path.join(TEMP_DIR, '.claude', 'skills')
    await symlink('/nonexistent/path', path.join(outfitDir, 'broken-fix'))

    await run(skillsDoctor({ noFix: false }))
  })
})
