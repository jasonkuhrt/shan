import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../../')

const runShan = async (homeDir: string, args: string[]) => {
  const proc = Bun.spawn([process.execPath, 'src/bin/shan.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: homeDir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

describe('skills install-user', () => {
  test('installs bundled skills into the user library and equips them', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'shan-install-user.'))

    try {
      const rootedSkillsDir = path.join(home, 'dotfiles-home/.claude/skills')
      const rootedLibraryDir = path.join(home, 'dotfiles-home/.claude/skills-library')
      const homeClaudeDir = path.join(home, '.claude')

      await mkdir(homeClaudeDir, { recursive: true })
      await mkdir(rootedSkillsDir, { recursive: true })
      await mkdir(rootedLibraryDir, { recursive: true })
      await symlink(rootedSkillsDir, path.join(homeClaudeDir, 'skills'))
      await symlink(rootedLibraryDir, path.join(homeClaudeDir, 'skills-library'))

      const oldShanPath = path.join(rootedSkillsDir, 'shan/SKILL.md')
      const oldSkillsPath = path.join(rootedSkillsDir, 'skills/SKILL.md')

      await mkdir(path.dirname(oldShanPath), { recursive: true })
      await mkdir(path.dirname(oldSkillsPath), { recursive: true })
      await writeFile(oldShanPath, 'old shan core dir')
      await writeFile(oldSkillsPath, 'old skills core dir')

      const result = await runShan(home, ['skills', 'install-user'])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Installing bundled shan skills')

      const skillFiles = [
        path.join(home, '.claude/skills-library/shan/SKILL.md'),
        path.join(home, '.claude/skills-library/skills/SKILL.md'),
        path.join(home, '.claude/skills-library/skills/change/SKILL.md'),
        path.join(home, '.claude/skills-library/skills/list/SKILL.md'),
        path.join(home, '.claude/skills-library/skills/doctor/SKILL.md'),
      ]
      const skillStats = await Promise.all(skillFiles.map((f) => lstat(f)))
      for (const fileStat of skillStats) {
        expect(fileStat.isFile()).toBe(true)
      }

      const expectedLinks = [
        ['shan', 'shan'],
        ['skills', 'skills'],
        ['skills_change', 'skills/change'],
        ['skills_list', 'skills/list'],
        ['skills_doctor', 'skills/doctor'],
      ] as const

      const linkChecks = await Promise.all(
        expectedLinks.map(async ([entryName, relPath]) => {
          const entryPath = path.join(home, '.claude/skills', entryName)
          const entryStat = await lstat(entryPath)
          const target = await readlink(entryPath)
          return { entryStat, target, relPath }
        }),
      )
      for (const check of linkChecks) {
        expect(check.entryStat.isSymbolicLink()).toBe(true)
        expect(check.target).toBe(path.join(home, '.claude/skills-library', check.relPath))
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
