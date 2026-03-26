import { describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../../')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const runShan = async (homeDir: string, args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn([process.execPath, 'src/bin/shan.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env, HOME: homeDir },
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

  test('syncs configured codex mirrors to the canonical claude outfit', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'shan-install-user-mirror.'))

    try {
      const configDir = path.join(home, '.config', 'shan')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify(
          {
            version: 1,
            skills: {
              historyLimit: 50,
              defaultScope: 'project',
              agents: ['claude', 'codex'],
            },
          },
          null,
          2,
        ) + '\n',
      )

      const result = await runShan(home, ['skills', 'install-user'])

      expect(result.exitCode).toBe(0)

      const codexLinks = [
        'shan',
        'skills',
        'skills_change',
        'skills_list',
        'skills_doctor',
      ] as const

      const checks = await Promise.all(
        codexLinks.map(async (entry) => {
          const mirrorPath = path.join(home, '.codex', 'skills', entry)
          const stat = await lstat(mirrorPath)
          const target = await readlink(mirrorPath)
          return { stat, target, entry }
        }),
      )

      for (const check of checks) {
        expect(check.stat.isSymbolicLink()).toBe(true)
        expect(check.target).toBe(path.join(home, '.claude', 'skills', check.entry))
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('auto-detects codex, writes the cache, and reuses the cached result', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'shan-install-user-auto-agents.'))

    try {
      const binDir = path.join(home, 'bin')
      const codexBin = path.join(binDir, 'codex')
      const cacheFile = path.join(home, '.local', 'shan', 'cache.json')
      await mkdir(binDir, { recursive: true })
      await writeFile(codexBin, '#!/bin/sh\nexit 0\n')
      await chmod(codexBin, 0o755)

      const first = await runShan(home, ['skills', 'install-user'], {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      })

      expect(first.exitCode).toBe(0)

      const rawCache: unknown = JSON.parse(await Bun.file(cacheFile).text())
      const agents = isRecord(rawCache) ? rawCache['agents'] : null
      const installed = isRecord(agents) ? agents['installed'] : null
      expect(isRecord(rawCache)).toBe(true)
      expect(isRecord(agents)).toBe(true)
      expect(Array.isArray(installed) ? installed : []).toContain('codex')

      const firstMirrorStat = await lstat(path.join(home, '.codex', 'skills', 'shan'))
      expect(firstMirrorStat.isSymbolicLink()).toBe(true)

      await rm(codexBin, { force: true })

      const second = await runShan(home, ['skills', 'install-user'], {
        PATH: process.env['PATH'] ?? '',
      })

      expect(second.exitCode).toBe(0)

      const cachedMirrorStat = await lstat(path.join(home, '.codex', 'skills', 'shan'))
      expect(cachedMirrorStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
