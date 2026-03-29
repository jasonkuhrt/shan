import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import type { DoctorContext, DoctorFinding } from '../../lib/doctor-aspects.js'
import * as Lib from '../../lib/skill-library.js'
import { autoFixDoctorFindings, collectDoctorFindings, skillsDoctor } from './doctor.js'
import { skillsOn } from './on.js'
import { registerStateFileRestore } from './test-state.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const RAW_BASE = path.join(tmpdir(), `shan-doctor-test-${Math.random().toString(36).slice(2, 8)}`)
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

  test('auto-fix keeps repairing fixable issues even when corrupt library entries remain', async () => {
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const corruptColonName = 'zzcorrupt__test-entry'
    const corruptDir = path.join(libDir, 'zzcorrupt__test-entry')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(
      path.join(corruptDir, 'SKILL.md'),
      '---\nname: "zzcorrupt__test-entry"\ndescription: Corrupt skill\n---\n# zzcorrupt__test-entry\n',
    )
    await writeFile(
      path.join(TEMP_DIR, '.gitignore'),
      [
        '# shan-managed (do not edit)',
        '.claude/skills/missing-skill',
        '# end shan-managed',
        '',
      ].join('\n'),
    )

    const before = await run(collectDoctorFindings('project'))
    expect(before).not.toBeNull()
    if (!before) throw new Error('expected doctor findings before autofix')
    expect(before.findings.some((finding) => finding.aspect === 'stale-gitignore')).toBe(true)
    expect(
      before.findings.some(
        (finding) =>
          finding.aspect === 'corrupt-library-entry' && finding.message.includes(corruptColonName),
      ),
    ).toBe(true)

    const outcome = await run(autoFixDoctorFindings('project'))
    const gitignore = await readFile(path.join(TEMP_DIR, '.gitignore'), 'utf-8')

    expect(outcome.fixedCount).toBeGreaterThanOrEqual(1)
    expect(gitignore).not.toContain('.claude/skills/missing-skill')
    expect(
      outcome.remainingFindings.some(
        (finding) =>
          finding.aspect === 'corrupt-library-entry' && finding.message.includes(corruptColonName),
      ),
    ).toBe(true)
  })

  test('auto-fix repairs deterministically canonicalizable corrupt frontmatter names', async () => {
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const skillDir = path.join(libDir, 'skills', 'change', 'undo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: "skills:change_undo"\ndescription: Corrupt skill\n---\n# skills:change_undo\n',
    )

    const before = await run(collectDoctorFindings('project'))
    expect(before).not.toBeNull()
    if (!before) throw new Error('expected doctor findings before autofix')
    expect(
      before.findings.some(
        (finding) =>
          finding.aspect === 'corrupt-library-entry' &&
          finding.message.includes('skills:change_undo'),
      ),
    ).toBe(true)

    const outcome = await run(autoFixDoctorFindings('project'))

    expect(
      outcome.fixDescriptions.some((description) =>
        description.includes('rewrote frontmatter name: skills:change_undo → skills:change:undo'),
      ),
    ).toBe(true)
    expect(
      outcome.remainingFindings.some((finding) => finding.aspect === 'corrupt-library-entry'),
    ).toBe(false)

    const content = await readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(content).toContain('name: "skills:change:undo"')
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

  test('returns immediately when no doctor context is available', async () => {
    const outcome = await run(autoFixDoctorFindings('project', () => Effect.succeed(null)))

    expect(outcome).toEqual({
      fixedCount: 0,
      fixDescriptions: [],
      remainingFindings: [],
    })
  })

  test('records failed fixes once and does not retry them in the same run', async () => {
    let attempts = 0

    const collect = (_scope: 'user' | 'project') =>
      Effect.succeed({
        ctx: {
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
        } satisfies DoctorContext,
        findings: [
          {
            aspect: 'broken-fix',
            level: 'error',
            message: 'always fails',
            fixable: true,
            fix: () => {
              attempts++
              return Effect.fail(new Error('boom'))
            },
          },
        ] satisfies DoctorFinding[],
      })

    const outcome = await run(autoFixDoctorFindings('project', collect))

    expect(attempts).toBe(1)
    expect(outcome.fixedCount).toBe(0)
    expect(outcome.fixDescriptions).toEqual([])
    expect(outcome.remainingFindings).toHaveLength(1)
  })

  test('skillsDoctor keeps unfixable findings visible and trims history to the configured limit', async () => {
    const libDir = path.join(TEMP_DIR, '.claude', 'skills-library')
    const corruptDir = path.join(libDir, 'zzcorrupt__test-entry')

    await mkdir(corruptDir, { recursive: true })
    await writeFile(
      path.join(corruptDir, 'SKILL.md'),
      '---\nname: "zzcorrupt__test-entry"\ndescription: Corrupt skill\n---\n# zzcorrupt__test-entry\n',
    )
    await writeFile(
      path.join(TEMP_DIR, '.gitignore'),
      [
        '# shan-managed (do not edit)',
        '.claude/skills/missing-skill',
        '# end shan-managed',
        '',
      ].join('\n'),
    )
    await mkdir(path.dirname(Lib.CONFIG_FILE), { recursive: true })
    await writeFile(
      Lib.CONFIG_FILE,
      JSON.stringify(
        {
          version: 1,
          skills: {
            historyLimit: 0,
            defaultScope: 'project',
            agents: ['claude'],
          },
        },
        null,
        2,
      ) + '\n',
    )

    await run(skillsDoctor({ noFix: false }))

    const gitignore = await readFile(path.join(TEMP_DIR, '.gitignore'), 'utf-8')
    const state = await run(Lib.loadState())
    const history = Lib.getProjectHistory(state, 'project')

    expect(gitignore).not.toContain('.claude/skills/missing-skill')
    expect(history.entries).toEqual([])
  })
})
