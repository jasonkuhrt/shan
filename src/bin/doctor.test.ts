import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as Lib from '../lib/skill-library.js'
import { doctor, selectConfigFindings } from './doctor.js'
import type { Finding as LintFinding } from './lint/finding.js'
import { skillsOn } from './skills/on.js'

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const skillMarkdown = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`

const setupProjectLibrary = async (...skills: string[]) => {
  const libraryDir = path.join(process.cwd(), '.claude', 'skills-library')
  for (const skill of skills) {
    const skillDir = path.join(libraryDir, skill)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), skillMarkdown(skill))
  }
}

const makeLintFinding = (overrides: Partial<LintFinding> = {}): LintFinding => ({
  file: '~/.claude/settings.json',
  location: 'hooks.Stop[0].hooks[0]',
  command: '.claude/hooks/foo.sh',
  severity: 'error',
  rule: 'no-relative-hook-path',
  message: 'Relative path breaks when Claude changes directory',
  detail: 'Details',
  happyPaths: [],
  references: [],
  ...overrides,
})

describe('doctor', () => {
  test('rejects unknown selectors', async () => {
    await expect(run(doctor({ selector: 'bogus', noFix: false }))).rejects.toThrow(
      'Unknown command',
    )
  })

  test('honors legacy skills.doctor.disabled config entries', async () => {
    await mkdir(path.dirname(Lib.CONFIG_FILE), { recursive: true })
    await writeFile(
      Lib.CONFIG_FILE,
      JSON.stringify({
        version: 1,
        skills: {
          historyLimit: 50,
          defaultScope: 'project',
          agents: ['claude'],
          doctor: { disabled: ['broken-symlink'] },
        },
      }),
    )
    await setupProjectLibrary('doctor-skill')
    await run(skillsOn('doctor-skill', { scope: 'project', strict: false }))

    const outfitDir = path.join(process.cwd(), '.claude', 'skills')
    await symlink('/nonexistent/path', path.join(outfitDir, 'broken-link'))

    await run(doctor({ selector: 'skills', noFix: true }))
  })

  test('supports exact config rule selectors', async () => {
    await mkdir(path.join(process.cwd(), '.claude'), { recursive: true })
    await writeFile(
      path.join(process.cwd(), '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/foo.sh' }] }],
        },
      }),
    )

    await expect(
      run(doctor({ selector: 'config/no-relative-hook-path', noFix: true })),
    ).rejects.toThrow('Doctor errors found')
  })

  test('selectConfigFindings filters exact rule selectors across multiple config rules', () => {
    const findings = selectConfigFindings('config/no-relative-hook-path', new Set(), [
      makeLintFinding({ rule: 'no-relative-hook-path' }),
      makeLintFinding({ rule: 'no-shell-eval' }),
    ])

    expect(findings.map((finding) => finding.rule)).toEqual(['config/no-relative-hook-path'])
  })

  test('skips disabled config rules from root doctor config', async () => {
    await mkdir(path.dirname(Lib.CONFIG_FILE), { recursive: true })
    await writeFile(
      Lib.CONFIG_FILE,
      JSON.stringify({
        version: 1,
        doctor: { disabled: ['config/no-relative-hook-path'] },
      }),
    )
    await mkdir(path.join(process.cwd(), '.claude'), { recursive: true })
    await writeFile(
      path.join(process.cwd(), '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/foo.sh' }] }],
        },
      }),
    )

    await run(doctor({ selector: 'config', noFix: false }))
  })

  test('reports exact skills rule selectors in no-fix mode', async () => {
    await setupProjectLibrary('doctor-skill')
    await run(skillsOn('doctor-skill', { scope: 'project', strict: false }))

    const outfitDir = path.join(process.cwd(), '.claude', 'skills')
    await symlink('/nonexistent/path', path.join(outfitDir, 'broken-link'))

    await expect(run(doctor({ selector: 'skills/broken-symlink', noFix: true }))).rejects.toThrow(
      'Doctor errors found',
    )
  })

  test('auto-fixes selected skills findings and records doctor history', async () => {
    await setupProjectLibrary('healthy-skill')
    await writeFile(
      path.join(process.cwd(), '.gitignore'),
      [
        '# shan-managed (do not edit)',
        '.claude/skills/missing-skill',
        '# end shan-managed',
        '',
      ].join('\n'),
    )

    await run(doctor({ selector: 'skills/stale-gitignore', noFix: false }))

    const gitignore = await readFile(path.join(process.cwd(), '.gitignore'), 'utf-8')
    const state = await run(Lib.loadState())
    const history = Lib.getProjectHistory(state, 'project')

    expect(gitignore).not.toContain('.claude/skills/missing-skill')
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]?._tag).toBe('DoctorOp')
  })

  test('trims doctor history and keeps remaining skills findings visible after autofix', async () => {
    const libraryDir = path.join(process.cwd(), '.claude', 'skills-library')
    const corruptDir = path.join(libraryDir, 'zzcorrupt__test-entry')

    await mkdir(corruptDir, { recursive: true })
    await writeFile(
      path.join(corruptDir, 'SKILL.md'),
      '---\nname: "zzcorrupt__test-entry"\ndescription: Corrupt skill\n---\n# zzcorrupt__test-entry\n',
    )
    await writeFile(
      path.join(process.cwd(), '.gitignore'),
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
      JSON.stringify({
        version: 1,
        skills: {
          historyLimit: 0,
          defaultScope: 'project',
          agents: ['claude'],
        },
      }),
    )

    await expect(run(doctor({ selector: 'skills', noFix: false }))).rejects.toThrow(
      'Doctor errors found',
    )

    const gitignore = await readFile(path.join(process.cwd(), '.gitignore'), 'utf-8')
    const state = await run(Lib.loadState())
    const history = Lib.getProjectHistory(state, 'project')

    expect(gitignore).not.toContain('.claude/skills/missing-skill')
    expect(history.entries).toEqual([])
  })
})
