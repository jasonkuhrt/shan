import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import type { DoctorContext, DoctorFinding } from '../../lib/doctor-aspects.js'
import { autoFixDoctorFindings, collectDoctorFindings, skillsDoctor } from './doctor.js'
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

  test('scope=user ignores project-only doctor findings', async () => {
    await setupProjectLibrary('doctor-skill')
    await writeFile(
      path.join(TEMP_DIR, '.gitignore'),
      [
        '# shan-managed (do not edit)',
        '.claude/skills/missing-skill',
        '# end shan-managed',
        '',
      ].join('\n'),
    )

    const projectResult = await run(collectDoctorFindings('project'))
    expect(projectResult).not.toBeNull()
    if (!projectResult) throw new Error('expected project doctor findings')
    expect(
      projectResult.findings.some((finding) =>
        finding.message.includes('.claude/skills/missing-skill'),
      ),
    ).toBe(true)

    const userResult = await run(collectDoctorFindings('user'))
    expect(userResult).not.toBeNull()
    if (!userResult) throw new Error('expected user doctor findings')
    expect(
      userResult.findings.some((finding) =>
        finding.message.includes('.claude/skills/missing-skill'),
      ),
    ).toBe(false)
  })

  test('re-detects after each fix so stale overlapping fixes do not clobber prior repairs', async () => {
    let targetState: 'user' | 'project' = 'user'

    const dummyContext: DoctorContext = {
      scope: 'project',
      state: { version: 2, current: {}, history: {} },
      library: [],
      userLibraryDir: '/tmp/user-library',
      projectLibraryDir: '/tmp/project-library',
      userOutfit: [],
      userOutfitDir: '/tmp/user-outfit',
      projectOutfit: [],
      projectOutfitDir: '/tmp/project-outfit',
      gitignoreEntries: [],
      config: {
        version: 1,
        skills: {
          historyLimit: 50,
          defaultScope: 'project',
          agents: ['claude', 'codex'],
        },
      },
      configuredAgents: ['claude', 'codex'],
    }

    const collect = (_scope: 'user' | 'project') =>
      Effect.succeed(
        targetState === 'user'
          ? {
              ctx: dummyContext,
              findings: [
                {
                  aspect: 'stale-shadow',
                  level: 'warning',
                  message: '[project] shared-skill should repoint to the project library',
                  fixable: true,
                  fix: () =>
                    Effect.sync(() => {
                      targetState = 'project'
                      return 'repointed: shared-skill → project library'
                    }),
                },
                {
                  aspect: 'cross-scope-install',
                  level: 'error',
                  message: '[project] shared-skill still points to the user library',
                  fixable: true,
                  fix: () =>
                    Effect.sync(() => {
                      targetState = 'user'
                      return 'removed cross-scope symlink: shared-skill'
                    }),
                },
              ] satisfies DoctorFinding[],
            }
          : { ctx: dummyContext, findings: [] satisfies DoctorFinding[] },
      )

    const outcome = await run(autoFixDoctorFindings('project', collect))

    expect(outcome.fixedCount).toBe(1)
    expect(outcome.fixDescriptions).toEqual(['repointed: shared-skill → project library'])
    expect(targetState as 'user' | 'project').toBe('project')
  })
})
